//! End-to-end test of the MCP stdio client against a fake server that
//! speaks just enough JSON-RPC: initialize, tools/list, tools/call. The
//! fake also emits a stray notification and a non-JSON log line, which a
//! real server may do and the client must skip.

use private_room_lib::mcp;

fn connect_err(result: Result<(mcp::Client, Vec<mcp::Tool>), String>) -> String {
    match result {
        Ok(_) => panic!("connect unexpectedly succeeded"),
        Err(e) => e,
    }
}

const FAKE_SERVER: &str = r#"
import sys, json

def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

print("fake-mcp starting up")  # stdout noise the client must skip
send({"jsonrpc": "2.0", "method": "notifications/stray", "params": {}})

for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": msg["id"], "result": {
            "protocolVersion": "2025-06-18",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "fake", "version": "1.0"}}})
    elif method == "tools/list":
        send({"jsonrpc": "2.0", "id": msg["id"], "result": {"tools": [
            {"name": "echo", "description": "Echo text back.",
             "inputSchema": {"type": "object",
                             "properties": {"text": {"type": "string"}},
                             "required": ["text"]}},
            {"name": "always-fails", "description": "Returns an error.",
             "inputSchema": {"type": "object", "properties": {}}}]}})
    elif method == "tools/call":
        name = msg["params"]["name"]
        if name == "echo":
            text = msg["params"]["arguments"].get("text", "")
            send({"jsonrpc": "2.0", "id": msg["id"], "result": {
                "content": [{"type": "text", "text": "echo: " + text}]}})
        else:
            send({"jsonrpc": "2.0", "id": msg["id"], "result": {
                "isError": True,
                "content": [{"type": "text", "text": "it broke"}]}})
"#;

fn fake_config() -> mcp::ServerConfig {
    mcp::ServerConfig {
        command: "python3".into(),
        args: vec!["-c".into(), FAKE_SERVER.into()],
        env: Default::default(),
        disabled: false,
    }
}

#[tokio::test]
async fn initialize_list_and_call() {
    let (mut client, tools) = mcp::Client::connect(&fake_config())
        .await
        .expect("connect to fake server");
    assert_eq!(tools.len(), 2);
    assert_eq!(tools[0].name, "echo");
    assert_eq!(tools[0].schema["properties"]["text"]["type"], "string");

    let out = client
        .call_tool("echo", &serde_json::json!({"text": "hi there"}))
        .await
        .expect("echo call");
    assert_eq!(out, "echo: hi there");

    let err = client
        .call_tool("always-fails", &serde_json::json!({}))
        .await
        .expect_err("isError must surface as Err");
    assert!(err.contains("it broke"), "got: {err}");
}

/// Real-world check of the default config we ship. Ignored by default:
/// needs `uv` installed and internet. Run with
/// `cargo test --test mcp_client -- --ignored`.
#[tokio::test]
#[ignore]
async fn real_duckduckgo_server() {
    let config = mcp::ServerConfig {
        command: "uvx".into(),
        args: vec!["duckduckgo-mcp-server".into()],
        env: Default::default(),
        disabled: false,
    };
    let (mut client, tools) = mcp::Client::connect(&config)
        .await
        .expect("connect to duckduckgo-mcp-server");
    let names: Vec<&str> = tools.iter().map(|t| t.name.as_str()).collect();
    assert!(!tools.is_empty(), "server listed no tools");
    println!("duckduckgo tools: {names:?}");

    let search = tools
        .iter()
        .find(|t| t.name.contains("search"))
        .expect("a search tool");
    let out = client
        .call_tool(&search.name, &serde_json::json!({"query": "rust language"}))
        .await
        .expect("live search");
    println!("first result chars: {}", &out.chars().take(200).collect::<String>());
    assert!(!out.trim().is_empty());
}

#[tokio::test]
async fn missing_command_fails_cleanly() {
    let config = mcp::ServerConfig {
        command: "definitely-not-a-real-command-xyz".into(),
        args: vec![],
        env: Default::default(),
        disabled: false,
    };
    let err = connect_err(mcp::Client::connect(&config).await);
    assert!(err.contains("Could not start"), "got: {err}");
}

#[tokio::test]
async fn server_that_exits_immediately_reports_stderr() {
    let config = mcp::ServerConfig {
        command: "python3".into(),
        args: vec![
            "-c".into(),
            "import sys; print('boom: missing dependency', file=sys.stderr); sys.exit(1)".into(),
        ],
        env: Default::default(),
        disabled: false,
    };
    let err = connect_err(mcp::Client::connect(&config).await);
    assert!(err.contains("boom: missing dependency"), "got: {err}");
}
