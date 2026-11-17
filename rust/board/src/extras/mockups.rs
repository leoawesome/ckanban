//! `src/board/mockups.ts`: planning runs can't write files, so Claude puts each mockup in a
//! `<ckanban-mockup name="...">` block of its reply; the board saves it to the ticket's outputs folder. Stripping the
//! blocks from the chat is R5's (`sessions::text::strip_mockups`); this saves them.

use std::path::Path;

use crate::prompts::js::trim;
use crate::sessions::text::{mockup_name, FENCE_CLOSE, FENCE_OPEN, MOCKUP_BLOCK};

/// Where mockups live, relative to the outputs folder.
pub const MOCKUPS_DIR: &str = "mockups";

#[derive(Clone, Debug, PartialEq)]
pub struct Mockup {
    pub name: String,
    pub html: String,
}

/// `extractMockups`: the blocks in a reply (valid names only; a ``` fence around the HTML dropped).
pub fn extract_mockups(text: &str) -> Vec<Mockup> {
    let mut out = Vec::new();
    for c in MOCKUP_BLOCK.captures_iter(text) {
        let html = trim(&c[2]).to_string();
        let html = FENCE_OPEN.replace(&html, "").into_owned();
        let html = trim(&FENCE_CLOSE.replace(&html, "")).to_string();
        if let Some(name) = mockup_name(&c[1])
            && !html.is_empty()
        {
            out.push(Mockup { name: name.to_string(), html });
        }
    }
    out
}

/// `saveMockups`: the reply's mockups written to `<output_dir>/mockups`; the names written.
pub fn save_mockups(output_dir: &Path, text: &str) -> std::io::Result<Vec<String>> {
    let mockups = extract_mockups(text);
    if mockups.is_empty() {
        return Ok(Vec::new());
    }
    let dir = output_dir.join(MOCKUPS_DIR);
    std::fs::create_dir_all(&dir)?;
    for m in &mockups {
        let body = if m.html.ends_with('\n') { m.html.clone() } else { format!("{}\n", m.html) };
        std::fs::write(dir.join(&m.name), body)?;
    }
    Ok(mockups.into_iter().map(|m| m.name).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_blocks() {
        let d = tempfile::tempdir().unwrap();
        let text = "Here:\n<ckanban-mockup name=\"a-x.html\">\n```html\n<p>a</p>\n```\n</ckanban-mockup>\n<ckanban-mockup name=\"../b.html\"><p/></ckanban-mockup>";
        assert_eq!(save_mockups(d.path(), text).unwrap(), vec!["a-x.html"]);
        assert_eq!(std::fs::read_to_string(d.path().join("mockups/a-x.html")).unwrap(), "<p>a</p>\n");
    }
}
