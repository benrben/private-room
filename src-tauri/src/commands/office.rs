use super::*;

/// HIGH-FIDELITY OFFICE RENDERING, using the renderers already on the Mac.
///
/// WHY: the hand-written OOXML slide renderer this replaces drew text and
/// pictures at their real positions and nothing else — no slide background, no
/// theme, no shape fills, no placeholder type scale. On a real deck that is
/// almost the entire design: a title slide whose actual look is a mint-green
/// band under 130pt serif type came out as two lines of 18px text on white.
/// "Roughly where the words are" is not a preview of a presentation.
///
/// macOS renders every one of these formats properly — it is the same Quick
/// Look machinery behind pressing space in Finder, and `textutil` is the same
/// Word importer behind TextEdit. Both ship with the OS, both work offline, and
/// neither is a dependency to bundle, sign or notarize. Using them is how the
/// preview becomes the document instead of an approximation of it.

// ------------------------------------------------------------- slide images

/// Rendered slides, keyed by `<file id>:<index>:<digest of the bytes>`. A Quick
/// Look render costs hundreds of milliseconds, and paging back and forth
/// through a deck must not pay it twice. Cleared with the room, like every
/// other decrypted derivative.
///
/// The DIGEST is in the key because a file id outlives the file's contents:
/// restoring a version rewrites the bytes under the same id, and a cache keyed
/// on the id alone kept answering with the previous deck's slides while the
/// page count came from the new bytes.
#[derive(Default)]
pub struct SlideCache {
    /// Each PNG with the counter it was inserted at, which is what orders
    /// eviction at the ceiling.
    pub map: Mutex<HashMap<String, (u64, String)>>,
    pub inserted: std::sync::atomic::AtomicU64,
}

/// Slides held at once. A deck's worth of PNGs is a few MB; past this the
/// oldest go rather than growing without bound.
const MAX_CACHED_SLIDES: usize = 60;

pub(crate) fn clear_slides(cache: &SlideCache) {
    cache.map.lock().unwrap().clear();
}

/// Rewrite a deck so slide `index` is the FIRST slide.
///
/// This is the trick that makes per-slide rendering possible at all. Quick Look
/// renders page one of a document and offers no way to ask for another, but a
/// `.pptx` states its own running order in `<p:sldIdLst>` inside
/// `ppt/presentation.xml`. Moving the wanted slide to the front of that list —
/// and changing nothing else, so every layout, master, theme and image part is
/// still exactly where its relationships say — makes the slide you want the one
/// Quick Look draws.
///
/// Slides are REORDERED rather than deleted: dropping the others would mean
/// pruning their relationships, notes and media too, and any mistake there
/// produces a file the renderer quietly refuses.
pub(crate) fn deck_with_slide_first(bytes: &[u8], index: usize) -> Result<Vec<u8>, String> {
    use std::io::Write;
    const PART: &str = "ppt/presentation.xml";
    let xml = extraction::read_zip_entry(bytes, PART)
        .ok_or("This file is not a readable .pptx presentation.")?;

    let (list_start, list_end) = find_tag_body(&xml, "p:sldIdLst")
        .ok_or("This presentation does not list its slides, so its pages can't be drawn.")?;
    let ids = split_self_closing(&xml[list_start..list_end], "p:sldId");
    if ids.is_empty() {
        return Err("This presentation has no slides.".into());
    }
    if index >= ids.len() {
        return Err(format!("This presentation has {} slides.", ids.len()));
    }
    // Slide `index` first, the rest in their original order behind it.
    let mut reordered = String::with_capacity(list_end - list_start);
    reordered.push_str(ids[index]);
    for (i, id) in ids.iter().enumerate() {
        if i != index {
            reordered.push_str(id);
        }
    }
    let patched = format!("{}{}{}", &xml[..list_start], reordered, &xml[list_end..]);

    // Copy every other part through untouched (raw, so nothing is recompressed
    // or re-encoded and the media stays byte-identical).
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| e.to_string())?;
    let mut out = std::io::Cursor::new(Vec::new());
    let mut writer = zip::ZipWriter::new(&mut out);
    for i in 0..archive.len() {
        let entry = archive.by_index_raw(i).map_err(|e| e.to_string())?;
        if entry.name() == PART {
            drop(entry);
            writer
                .start_file(PART, zip::write::SimpleFileOptions::default())
                .map_err(|e| e.to_string())?;
            writer.write_all(patched.as_bytes()).map_err(|e| e.to_string())?;
        } else {
            writer.raw_copy_file(entry).map_err(|e| e.to_string())?;
        }
    }
    writer.finish().map_err(|e| e.to_string())?;
    Ok(out.into_inner())
}

/// Byte range of an element's BODY (between `<tag …>` and `</tag>`).
fn find_tag_body(xml: &str, tag: &str) -> Option<(usize, usize)> {
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let at = xml.find(&open)?;
    let body = xml[at..].find('>').map(|i| at + i + 1)?;
    let end = xml[body..].find(&close).map(|i| body + i)?;
    Some((body, end))
}

/// Every `<tag …/>` (or `<tag …></tag>`) element in a fragment, as slices.
///
/// The long spelling is a WHOLE element: PowerPoint writes
/// `<p:sldId id="256" r:id="rId1"><p:extLst>…</p:extLst></p:sldId>`, and
/// carrying only its opening tag through left the rewritten `<p:sldIdLst>`
/// unbalanced — Quick Look then refuses the staged file and every slide but
/// the first came back undrawable.
fn split_self_closing<'a>(fragment: &'a str, tag: &str) -> Vec<&'a str> {
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let mut out = Vec::new();
    let mut from = 0usize;
    while let Some(rel) = fragment[from..].find(&open) {
        let start = from + rel;
        let Some(gt) = fragment[start..].find('>').map(|i| start + i + 1) else { break };
        let end = if fragment[start..gt].ends_with("/>") {
            gt
        } else {
            // An element whose closing tag is missing is not one we can move,
            // so the scan stops rather than emitting half of it.
            let Some(rel) = fragment[gt..].find(&close) else { break };
            gt + rel + close.len()
        };
        out.push(&fragment[start..end]);
        from = end;
    }
    out
}

/// How many slides a deck has — so the viewer can page through it without
/// parsing the archive twice.
pub(crate) fn slide_count_of(bytes: &[u8]) -> usize {
    let Some(xml) = extraction::read_zip_entry(bytes, "ppt/presentation.xml") else { return 0 };
    let Some((s, e)) = find_tag_body(&xml, "p:sldIdLst") else { return 0 };
    split_self_closing(&xml[s..e], "p:sldId").len()
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SlideImage {
    pub png_b64: String,
    pub slides: usize,
}

/// One slide of a `.pptx`, drawn by macOS at full fidelity.
#[tauri::command]
pub async fn slide_preview(
    app: tauri::AppHandle,
    id: String,
    index: usize,
) -> Result<Option<SlideImage>, String> {
    use tauri::Manager;
    let (name, bytes) = {
        let state = app.state::<AppState>();
        let guard = state.room.lock().unwrap();
        let room = guard.as_ref().ok_or("No room is open.")?;
        let (name, _mime, bytes, _text) = db::get_file_full(&room.conn, &id)?;
        (name, bytes.unwrap_or_default())
    };
    if bytes.is_empty() {
        return Ok(None);
    }
    // A legacy binary `.ppt` has no `<p:sldIdLst>` to read or reorder — it is
    // an OLE compound file, not a zip of XML. Quick Look still renders its
    // FIRST slide perfectly, so it is treated as a one-page document rather
    // than reported as undrawable. Its full text is separately recovered by
    // `extraction::legacy`, so nothing about the deck is actually lost.
    let ooxml = slide_count_of(&bytes);
    let slides = ooxml.max(1);
    if index >= slides {
        return Ok(None);
    }
    let key = format!("{id}:{index}:{}", deck_digest(&bytes));
    {
        let cache = app.state::<SlideCache>();
        let hit = cache.map.lock().unwrap().get(&key).map(|(_, png)| png.clone());
        if let Some(png_b64) = hit {
            return Ok(Some(SlideImage { png_b64, slides }));
        }
    }
    let png = tauri::async_runtime::spawn_blocking(move || {
        // Slide 0 is already first, and a legacy .ppt can't be reordered at
        // all: in both cases render the file exactly as it stands.
        let staged = if index == 0 || ooxml == 0 {
            bytes
        } else {
            deck_with_slide_first(&bytes, index)?
        };
        Ok::<Option<Vec<u8>>, String>(crate::quicklook::preview_png(&name, &staged))
    })
    .await
    .map_err(|e| format!("The slide could not be drawn: {e}"))??;

    let Some(png) = png else { return Ok(None) };
    let png_b64 = base64::engine::general_purpose::STANDARD.encode(png);
    let cache = app.state::<SlideCache>();
    let seq = cache.inserted.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut map = cache.map.lock().unwrap();
    evict_to_fit(&mut map, MAX_CACHED_SLIDES);
    map.insert(key, (seq, png_b64.clone()));
    Ok(Some(SlideImage { png_b64, slides }))
}

/// Which deck these bytes are, so a rewritten file cannot be answered with the
/// previous one's slides.
fn deck_digest(bytes: &[u8]) -> String {
    use sha2::Digest;
    let mut h = sha2::Sha256::new();
    h.update(bytes);
    format!("{:x}", h.finalize())
}

/// Make room for one more entry by dropping the OLDEST, one at a time.
///
/// Emptying the map at the ceiling — which is what this used to do — meant a
/// deck longer than the ceiling paid a fresh Quick Look render for every slide
/// from then on, including the one the reader had just come from.
fn evict_to_fit(map: &mut HashMap<String, (u64, String)>, ceiling: usize) {
    while map.len() >= ceiling {
        let Some(oldest) = map.iter().min_by_key(|(_, (seq, _))| *seq).map(|(k, _)| k.clone())
        else {
            break;
        };
        map.remove(&oldest);
    }
}

// -------------------------------------------------------------- Word as HTML

/// A legacy `.doc` (and `.rtf`) rendered as formatted HTML by macOS's own Word
/// importer — the one behind TextEdit — rather than shown as recovered plain
/// text.
///
/// `textutil` ships with every Mac at a fixed path, so unlike the optional
/// third-party converter this replaces there is nothing for anyone to install
/// and nothing to be missing. It keeps fonts, sizes, weights, colours,
/// alignment and lists, and the text stays real text: selectable, searchable,
/// and readable by a screen reader.
#[tauri::command]
pub async fn office_html(app: tauri::AppHandle, id: String) -> Result<Option<String>, String> {
    use tauri::Manager;
    let (name, bytes) = {
        let state = app.state::<AppState>();
        let guard = state.room.lock().unwrap();
        let room = guard.as_ref().ok_or("No room is open.")?;
        let (name, _mime, bytes, _text) = db::get_file_full(&room.conn, &id)?;
        (name, bytes.unwrap_or_default())
    };
    if bytes.is_empty() {
        return Ok(None);
    }
    tauri::async_runtime::spawn_blocking(move || Ok(textutil_html(&name, &bytes)))
        .await
        .map_err(|e| format!("The document could not be read: {e}"))?
}

fn textutil_html(name: &str, bytes: &[u8]) -> Option<String> {
    let html = crate::textutil::convert(name, bytes, "html")?;
    // Word FIELD CODES survive the import as literal characters, so a link read
    // as `HYPERLINK "https://products.office.com/en-us/word"Mauris id ex erat.`
    // — the document's machinery printed in the middle of its prose, and the
    // link itself not clickable. Resolve them into real anchors.
    Some(crate::textutil::resolve_field_codes(&html, true))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A deck whose presentation.xml lists `n` slides.
    fn fake_deck(n: usize) -> Vec<u8> {
        let ids: String = (1..=n)
            .map(|i| format!(r#"<p:sldId id="{}" r:id="rId{i}"/>"#, 255 + i))
            .collect();
        crate::extraction::fake_office_zip(
            "ppt/presentation.xml",
            &format!(
                r#"<p:presentation><p:sldMasterIdLst/><p:sldIdLst>{ids}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>"#
            ),
        )
    }

    fn id_order(bytes: &[u8]) -> Vec<String> {
        let xml = crate::extraction::read_zip_entry(bytes, "ppt/presentation.xml").unwrap();
        let (s, e) = find_tag_body(&xml, "p:sldIdLst").unwrap();
        split_self_closing(&xml[s..e], "p:sldId")
            .iter()
            .map(|el| {
                let at = el.find("r:id=\"").unwrap() + 6;
                el[at..el[at..].find('"').unwrap() + at].to_string()
            })
            .collect()
    }

    #[test]
    fn a_deck_counts_its_slides() {
        assert_eq!(slide_count_of(&fake_deck(7)), 7);
        assert_eq!(slide_count_of(b"not a pptx"), 0);
    }

    #[test]
    fn the_wanted_slide_is_moved_to_the_front_and_the_rest_keep_their_order() {
        // This is the whole mechanism: Quick Look draws page one, so page one
        // has to become the slide the reader asked for.
        let deck = fake_deck(5);
        let moved = deck_with_slide_first(&deck, 2).expect("reorder failed");
        assert_eq!(id_order(&moved), ["rId3", "rId1", "rId2", "rId4", "rId5"]);
    }

    #[test]
    fn asking_for_the_first_slide_changes_nothing_about_the_order() {
        let deck = fake_deck(4);
        let moved = deck_with_slide_first(&deck, 0).unwrap();
        assert_eq!(id_order(&moved), id_order(&deck));
    }

    #[test]
    fn every_other_part_survives_the_rewrite_byte_for_byte() {
        // Media, layouts, masters and themes are copied raw. If any of them
        // were dropped or re-encoded the renderer would refuse the file, which
        // is exactly the failure this guards.
        use std::io::Write;
        let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let opts: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default();
        w.start_file("ppt/presentation.xml", opts).unwrap();
        w.write_all(
            br#"<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>"#,
        )
        .unwrap();
        w.start_file("ppt/media/image1.png", opts).unwrap();
        w.write_all(b"\x89PNG\r\n\x1a\nPRETEND").unwrap();
        w.start_file("ppt/theme/theme1.xml", opts).unwrap();
        w.write_all(b"<a:theme/>").unwrap();
        let deck = w.finish().unwrap().into_inner();

        let moved = deck_with_slide_first(&deck, 1).unwrap();
        assert_eq!(
            crate::extraction::read_zip_entry(&moved, "ppt/theme/theme1.xml").as_deref(),
            Some("<a:theme/>")
        );
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(&moved)).unwrap();
        let mut media = Vec::new();
        std::io::Read::read_to_end(
            &mut archive.by_name("ppt/media/image1.png").unwrap(),
            &mut media,
        )
        .unwrap();
        assert_eq!(media, b"\x89PNG\r\n\x1a\nPRETEND");
    }

    #[test]
    fn a_slide_entry_written_the_long_way_keeps_its_closing_tag_and_its_children() {
        // PowerPoint writes `<p:sldId …><p:extLst>…</p:extLst></p:sldId>` as
        // readily as the self-closing spelling. Carrying only the opening tag
        // through left `<p:sldIdLst>` unbalanced, Quick Look refused the staged
        // file, and every slide but the first came back undrawable.
        let deck = crate::extraction::fake_office_zip(
            "ppt/presentation.xml",
            r#"<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId1"><p:extLst><p:ext uri="{ABC}"/></p:extLst></p:sldId><p:sldId id="257" r:id="rId2"></p:sldId></p:sldIdLst></p:presentation>"#,
        );
        assert_eq!(slide_count_of(&deck), 2);
        let moved = deck_with_slide_first(&deck, 1).expect("reorder failed");
        assert_eq!(id_order(&moved), ["rId2", "rId1"]);
        let out = crate::extraction::read_zip_entry(&moved, "ppt/presentation.xml").unwrap();
        assert_eq!(
            out.matches("<p:sldId ").count(),
            out.matches("</p:sldId>").count(),
            "the rewritten slide list is unbalanced: {out}"
        );
        assert!(out.contains("<p:ext uri="), "the element's children were dropped: {out}");
    }

    #[test]
    fn the_slide_cache_drops_its_oldest_entry_rather_than_emptying_itself() {
        // At the ceiling the whole map used to go, so a deck longer than the
        // ceiling re-rendered every slide from then on — including the one the
        // reader had just paged back from.
        let mut map: HashMap<String, (u64, String)> = HashMap::new();
        for i in 0..4u64 {
            map.insert(format!("deck:{i}:d"), (i, "png".into()));
        }
        evict_to_fit(&mut map, 4);
        assert_eq!(map.len(), 3);
        assert!(!map.contains_key("deck:0:d"), "the oldest should be the one that goes");
        assert!(map.contains_key("deck:3:d"), "the newest was kept");
        // A ceiling of zero empties the map and then stops — with nothing left
        // to evict the loop ends rather than spinning.
        evict_to_fit(&mut map, 0);
        assert!(map.is_empty());
    }

    #[test]
    fn an_out_of_range_slide_says_how_many_there_are() {
        let err = deck_with_slide_first(&fake_deck(3), 9).unwrap_err();
        assert!(err.contains('3'), "unhelpful message: {err}");
    }

    #[test]
    fn a_file_that_is_not_a_deck_is_refused_rather_than_corrupted() {
        assert!(deck_with_slide_first(b"not a pptx at all", 0).is_err());
    }

    #[test]
    fn a_legacy_binary_ppt_counts_as_one_page_rather_than_none() {
        // A .ppt is an OLE compound file with no slide list to read, so the
        // count is 0 — but Quick Look renders its first slide perfectly, and
        // reporting "no slides" would throw that away and show an error
        // instead of the deck.
        let ole = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1 not a zip";
        assert_eq!(slide_count_of(ole), 0);
        assert_eq!(slide_count_of(ole).max(1), 1, "a .ppt must still have one drawable page");
    }

    #[test]
    fn textutil_reads_a_real_rtf_into_html() {
        // Exercises the whole shell-out. (Temp-copy cleanup is asserted on the
        // guard itself in `crate::textutil` — counting files in the shared temp
        // dir races the other tests running in parallel.)
        let rtf = br"{\rtf1\ansi{\fonttbl\f0\froman Times;}\f0\fs48 Hello \b bold\b0  world.\par}";
        let html = textutil_html("sample.rtf", rtf).expect("no html from textutil");
        assert!(html.contains("Hello"), "{html}");
        assert!(html.to_lowercase().contains("<b>"), "bold was lost: {html}");
    }

    #[test]
    fn a_hyperlink_field_reaches_the_preview_as_a_real_link() {
        // Live QA: the reader printed the field's machinery in the middle of
        // the prose — `HYPERLINK "https://products.office.com/en-us/word"Mauris
        // id ex erat.` — and the link itself was not clickable.
        let rtf = br#"{\rtf1\ansi\f0\fs24 See {\field{\*\fldinst{HYPERLINK "https://example.com/page"}}{\fldrslt{the page}}} now.\par}"#;
        let html = textutil_html("linked.rtf", rtf).expect("no html");
        assert!(!html.contains("HYPERLINK"), "the field code leaked: {html}");
        assert!(html.contains("now."), "prose was eaten: {html}");
    }
}
