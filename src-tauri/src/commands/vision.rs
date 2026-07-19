use super::*;

/// The square canvas every image is fitted to before grounding. Exactly 1000 so
/// pixel coordinates and 0..1000-normalized coordinates COINCIDE (both divide to
/// the same 0..1 value) — which is what makes box placement robust regardless of
/// which convention the vision model answers in (see `prepare_image`).
pub(crate) const VISION_SQUARE: u32 = 1000;

/// Normalize an image for the model: transcode to PNG (Ollama only decodes
/// PNG/JPEG — WebP/HEIC/mislabeled files fail with "unknown format") and fit it
/// onto a fixed VISION_SQUARE×VISION_SQUARE canvas. Returns (bytes, width, height).
///
/// Marking fix: the image is STRETCHED to a square rather than kept at its own
/// aspect ratio. This removes the two things that were pushing highlight boxes
/// off — almost always downward: (1) the pixel-vs-0..1000 scale ambiguity
/// disappears, because on a 1000×1000 image both conventions normalize
/// identically; and (2) it pre-empts the vision model's OWN internal
/// square-padding, which otherwise squeezes a non-square image's content toward
/// the middle and drags the boxes down. Boxes are drawn back over the ORIGINAL
/// image using NORMALIZED coordinates, so the per-axis stretch cancels out
/// exactly — only the model's working view is distorted, never the placement.
pub(crate) fn prepare_image(bytes: &[u8]) -> (Vec<u8>, f64, f64) {
    let square = VISION_SQUARE as f64;
    match image::load_from_memory(bytes) {
        Ok(img) => {
            let (ow, oh) = (img.width() as f64, img.height() as f64);
            let fitted = img.resize_exact(
                VISION_SQUARE,
                VISION_SQUARE,
                image::imageops::FilterType::Triangle,
            );
            let mut out = Vec::new();
            if fitted
                .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
                .is_ok()
            {
                (out, square, square)
            } else {
                (bytes.to_vec(), ow, oh)
            }
        }
        Err(_) => {
            let (w, h) = imagesize::blob_size(bytes)
                .map(|s| (s.width as f64, s.height as f64))
                .unwrap_or((square, square));
            (bytes.to_vec(), w, h)
        }
    }
}

/// The grounding prompt Qwen-VL models were trained on.
pub(crate) fn grounding_prompt(query: &str, w: f64, h: f64) -> String {
    format!(
        "Outline the position of each instance of the following in this \
         {w:.0}x{h:.0} pixel image: {query}\n\
         Output ONLY a JSON array, no other text, in the format \
         [{{\"bbox_2d\": [x1, y1, x2, y2], \"label\": \"<short name>\"}}]. \
         One element per match, each with a distinct descriptive label. \
         If it is not in the image, output []."
    )
}

/// ADD-22: JSON schema handed to Ollama `format` for the grounding pass, so a
/// small vision model can only ever emit a well-formed box array. `parse_boxes`
/// still handles the coordinate-scale ambiguity (pixel vs 0-1000) a schema
/// can't express, but no longer has to salvage prose or malformed JSON.
pub(crate) fn boxes_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "array",
        "items": {
            "type": "object",
            "properties": {
                "bbox_2d": {
                    "type": "array",
                    "items": {"type": "number"},
                    "minItems": 4,
                    "maxItems": 4
                },
                "label": {"type": "string"}
            },
            "required": ["bbox_2d", "label"]
        }
    })
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImageBox {
    pub label: String,
    // Normalized 0..1 relative to the image, (0,0) = top-left.
    pub x1: f64,
    pub y1: f64,
    pub x2: f64,
    pub y2: f64,
}

pub(crate) fn parse_boxes(raw: &str, img_w: f64, img_h: f64) -> Vec<ImageBox> {
    // CHG-21: drop any <think>…</think> spans some models leak, then scan each
    // '[' as a candidate JSON array (the stream deserializer parses one balanced
    // value and ignores trailing prose), returning the first array that yields
    // at least one box. Robust to leading/trailing prose containing brackets,
    // unlike a single first-'['-to-last-']' slice.
    let cleaned = strip_think_spans(raw);
    let bracket_positions: Vec<usize> = cleaned
        .char_indices()
        .filter(|(_, c)| *c == '[')
        .map(|(i, _)| i)
        .take(8)
        .collect();
    for start in bracket_positions {
        let mut de = serde_json::Deserializer::from_str(&cleaned[start..]).into_iter::<serde_json::Value>();
        let items = match de.next() {
            Some(Ok(serde_json::Value::Array(items))) => items,
            _ => continue,
        };
        let boxes = boxes_from_items(items, img_w, img_h);
        if !boxes.is_empty() {
            return boxes;
        }
    }
    vec![]
}

/// Removing `<think>…</think>` spans (some non-grounding models leak them) is
/// the same job the LLM client does when salvaging structured output, so it
/// lives there. Re-exported so the command modules keep reaching it unqualified.
pub(crate) use crate::ollama::strip_think_spans;

pub(crate) fn boxes_from_items(items: Vec<serde_json::Value>, img_w: f64, img_h: f64) -> Vec<ImageBox> {
    let mut boxes = Vec::new();
    for item in items {
        let label = item["label"]
            .as_str()
            .or_else(|| item["name"].as_str())
            .unwrap_or("match")
            .to_string();
        // Requested "bbox_2d" is absolute pixels (Qwen-VL's native grounding
        // format). "box_2d" is Google-style [ymin, xmin, ymax, xmax] 0-1000.
        let (coords, y_first, pixels) = if item["bbox_2d"].is_array() {
            (item["bbox_2d"].as_array().unwrap(), false, true)
        } else if item["bbox"].is_array() {
            (item["bbox"].as_array().unwrap(), false, true)
        } else if item["box_2d"].is_array() {
            (item["box_2d"].as_array().unwrap(), true, false)
        } else if item["box"].is_array() {
            (item["box"].as_array().unwrap(), false, false)
        } else {
            continue;
        };
        if coords.len() != 4 {
            continue;
        }
        let vals: Vec<f64> = coords.iter().filter_map(|c| c.as_f64()).collect();
        if vals.len() != 4 {
            continue;
        }
        let (mut a, mut b, mut c, mut d) = if y_first {
            (vals[1], vals[0], vals[3], vals[2])
        } else {
            (vals[0], vals[1], vals[2], vals[3])
        };
        // Scale to 0..1. Pixel keys use the image dims — unless the values
        // overshoot them, which means the model answered in its own
        // 0-1000-normalized space (qwen2.5vl does this on small images).
        let max = vals.iter().cloned().fold(0.0, f64::max);
        let out_of_range = a.max(c) > img_w * 1.05 || b.max(d) > img_h * 1.05;
        let (sx, sy) = if max <= 1.0 {
            (1.0, 1.0)
        } else if pixels && !out_of_range {
            (img_w.max(1.0), img_h.max(1.0))
        } else {
            (1000.0, 1000.0)
        };
        a /= sx;
        c /= sx;
        b /= sy;
        d /= sy;
        if a > c {
            std::mem::swap(&mut a, &mut c);
        }
        if b > d {
            std::mem::swap(&mut b, &mut d);
        }
        let clamp = |v: f64| v.clamp(0.0, 1.0);
        let (a, b, c, d) = (clamp(a), clamp(b), clamp(c), clamp(d));
        if c - a < 0.001 || d - b < 0.001 {
            continue;
        }
        boxes.push(ImageBox {
            label,
            x1: a,
            y1: b,
            x2: c,
            y2: d,
        });
    }
    boxes
}

/// Shared inline image-grounding used by the agent's `mark_image` tool and its
/// post-answer auto-ground pass: run the vision model on a PREPARED (square-
/// stretched) image and parse the boxes. (The `locate_in_image` command grounds
/// via the sidecar's `/vision_locate` instead; unifying all three on the sidecar
/// is a follow-up that needs on-device vision QA.)
pub(crate) async fn ground_prepared_image(
    vmodel: &str,
    chat_model: &str,
    prepared: &[u8],
    query: &str,
    w: f64,
    h: f64,
) -> Result<Vec<ImageBox>, String> {
    let messages = vec![ollama::ChatMessage {
        role: "user".into(),
        content: grounding_prompt(query, w, h),
        images: Some(vec![base64::engine::general_purpose::STANDARD.encode(prepared)]),
        ..Default::default()
    }];
    // HLT-5: short keep_alive for this vision pass on low-RAM Macs.
    let keep = vision_keep_alive(total_ram_bytes(), vmodel, chat_model);
    let raw = ollama::chat_structured(
        vmodel,
        messages,
        Some(0.0),
        keep,
        &boxes_schema(),
        Default::default(),
    )
    .await?;
    Ok(parse_boxes(&raw, w, h))
}

#[tauri::command]
pub async fn locate_in_image(
    state: State<'_, AppState>,
    file_id: String,
    query: String,
    #[allow(unused_variables)] img_width: f64,
    #[allow(unused_variables)] img_height: f64,
) -> Result<Vec<ImageBox>, String> {
    // Rust keeps: the DB read (original file bytes) and the vision-model pick. The
    // prepare_image (transcode + 1000×1000 stretch), grounding prompt, boxes schema,
    // structured call and coordinate parse all now live in the sidecar's
    // /vision_locate — so we send the ORIGINAL bytes and it does the canvas work.
    let (explicit, bytes) = state.with_room(|room| {
        let bytes = db::get_file_bytes(&room.conn, &file_id)?;
        let bytes = bytes.ok_or("File has no stored content.")?;
        Ok((model_setting(&room.conn), bytes))
    })?;

    let models = ollama::list_models().await.unwrap_or_default();
    let chat_model = explicit.unwrap_or_else(|| best_default(&models));
    let mut vmodel = vision_model(&models, &chat_model);
    if is_external_engine(&vmodel) {
        if models.is_empty() {
            return Err("Marking images needs a local Ollama vision model.".into());
        }
        vmodel = best_default(&models);
    }

    // HLT-5: release the vision model quickly on low-RAM machines. num_ctx is left
    // unset so the sidecar sizes it to its chat-notools window — identical to the
    // old `StructuredOpts::default()` (Chat tier) this call used.
    let keep = vision_keep_alive(total_ram_bytes(), &vmodel, &chat_model);
    let body = serde_json::json!({
        "model": vmodel,
        "image_b64": base64::engine::general_purpose::STANDARD.encode(&bytes),
        "query": query,
        "base_url": ollama::resolved_base_url(),
        "temperature": 0.0,
        "keep_alive": keep,
    });
    let v = crate::sidecar::sidecar_json("/vision_locate", &body)
        .await
        .map_err(|e| e.sentinel(Some(&vmodel)))?;
    let boxes: Vec<ImageBox> = serde_json::from_value(v["boxes"].clone()).unwrap_or_default();
    Ok(boxes)
}

/// CHG-18: does the question want boxes drawn on the ATTACHED IMAGE? The trigger
/// is asymmetric because the costs are: a false positive loads a multi-GB vision
/// model (and can evict the chat model on a 16 GB Mac), while a false negative is
/// free — the agent loop still has the mark_image tool to recover. So unambiguous
/// marking verbs fire unconditionally; document/general verbs ("highlight",
/// "show me", "find the") fire only when the question also refers to the image;
/// and a question that names a non-image target (pdf/spreadsheet/doc) is skipped.
/// `image_name` is the attached image's file name, if any.
pub(crate) fn is_locate_intent(question: &str, image_name: Option<&str>) -> bool {
    let q = question.to_lowercase();
    // Names a different, non-image target → this is an annotate_file/open_file
    // job, not image grounding. Skip the vision pass.
    const OTHER_TARGETS: &[&str] = &[
        "pdf", "spreadsheet", "sheet", "workbook", "document", "the doc", "report", "the page",
    ];
    if OTHER_TARGETS.iter().any(|t| q.contains(t)) {
        return false;
    }
    // Unambiguous "mark it on the image" verbs — always trigger.
    const STRONG: &[&str] = &[
        "mark ", "mark the", "locate", "point to", "point out", "circle", "find where",
        "where is", "where are", "where's",
    ];
    if STRONG.iter().any(|k| q.contains(k)) {
        return true;
    }
    // Ambiguous document/general verbs — only when the question refers to the
    // image (an image-referential word, or the image's own file name).
    const WEAK: &[&str] = &["highlight", "show me", "find the", "find all"];
    if WEAK.iter().any(|k| q.contains(k)) {
        const IMG_REFS: &[&str] =
            &["image", "screenshot", "photo", "picture", "png", "jpg", "jpeg", "scan"];
        let refers_to_image = IMG_REFS.iter().any(|r| q.contains(r))
            || image_name
                .map(|n| q.contains(&n.to_lowercase()))
                .unwrap_or(false);
        return refers_to_image;
    }
    false
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locate_intent_only_fires_on_real_locate_questions() {
        let img = Some("photo.png");
        // Strong marking verbs fire regardless of image context.
        assert!(is_locate_intent("Where is the signature?", img));
        assert!(is_locate_intent("circle the cat", None));
        assert!(is_locate_intent("point to the exit", img));
        // "sign me" was a typo that fired the slow grounding pass on unrelated
        // sentences (RM-3) — it must not match anymore.
        assert!(!is_locate_intent("please sign me up for the newsletter", img));
        assert!(!is_locate_intent("summarize this document", img));
        // CHG-18: ambiguous verbs only fire when the question refers to the image.
        assert!(is_locate_intent("show me the cat in the photo", img));
        assert!(is_locate_intent("show me the cat in photo.png", Some("photo.png")));
        assert!(!is_locate_intent("show me a summary", img));
        // CHG-18: a named non-image target routes to annotate_file, not grounding.
        assert!(!is_locate_intent("highlight the total in the invoice PDF", img));
        assert!(!is_locate_intent("find the average in the spreadsheet", img));
        // "somewhere in this report" no longer matches on a bare "where".
        assert!(!is_locate_intent("somewhere in this report is a total", img));
    }

    #[test]
    fn parse_boxes_survives_prose_and_think_spans() {
        let w = 100.0;
        let h = 100.0;
        // Leading prose containing a bracket, then a real array.
        let raw = "Coordinates are [x1,y1,x2,y2]. Here: [{\"label\":\"cat\",\"bbox\":[10,10,50,50]}]";
        assert_eq!(parse_boxes(raw, w, h).len(), 1);
        // A <think> block preceding the array must not break parsing.
        let raw2 = "<think>let me look</think>[{\"label\":\"dog\",\"bbox\":[0,0,40,40]}]";
        assert_eq!(parse_boxes(raw2, w, h).len(), 1);
        // A genuine empty answer stays empty.
        assert_eq!(parse_boxes("[]", w, h).len(), 0);
    }

    #[test]
    fn prepare_image_fits_square_so_boxes_dont_drift_down() {
        // A wide, non-square image is fitted onto the 1000×1000 grounding canvas.
        let mut buf = Vec::new();
        image::DynamicImage::ImageRgb8(image::RgbImage::new(800, 300))
            .write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
            .unwrap();
        let (_bytes, w, h) = prepare_image(&buf);
        assert_eq!((w, h), (1000.0, 1000.0), "image is fitted to a square canvas");
        // A box the model reports centered vertically (0..1000 space) must land
        // centered — before the fix it was normalized by the 300px height and
        // shot far down the page.
        let items = vec![serde_json::json!({"bbox_2d": [100, 450, 900, 550], "label": "mid"})];
        let boxes = boxes_from_items(items, w, h);
        assert_eq!(boxes.len(), 1);
        assert!(
            (boxes[0].y1 - 0.45).abs() < 0.01 && (boxes[0].y2 - 0.55).abs() < 0.01,
            "vertical center stays centered: got y1={}, y2={}",
            boxes[0].y1,
            boxes[0].y2
        );
        assert!((boxes[0].x1 - 0.10).abs() < 0.01, "x maps cleanly too");
    }

}
