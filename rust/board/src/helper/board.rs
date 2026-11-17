//! What the helper reads from (and asks of) the board: tickets and boards from the index, live state (runs,
//! sessions, huddles), comments, and where links point. Made in `rust/src/board_mode.rs`; tests use their own.

use std::collections::HashSet;
use std::sync::Arc;

use serde_json::Value;

use crate::index::store::BoardList;
use crate::index::ticket::Tk;

pub trait HelperBoard: Send + Sync {
    fn ticket(&self, slug: &str, id: &str) -> Option<Arc<Tk>>;
    fn list(&self, slug: &str) -> Arc<BoardList>;
    /// Every board: (slug, name), in the store's order.
    fn profiles(&self) -> Vec<(String, String)>;
    /// The board exists.
    fn has_profile(&self, slug: &str) -> bool;
    /// `getProfile(slug)?.name ?? slug`.
    fn board_name(&self, slug: &str) -> String;
    fn session(&self, session_id: &str) -> Option<Value>;
    fn running(&self, slug: &str, id: &str) -> bool;
    fn host(&self, slug: &str, id: &str) -> Option<Value>;
    fn schedule_ids(&self, slug: &str) -> HashSet<String>;
    /// A schedule of the board has `quiet` (a check-in is set up).
    fn has_checkin(&self, slug: &str) -> bool;
    /// Writes an "ai" comment on a ticket.
    fn add_comment(&self, slug: &str, id: &str, text: &str);
    /// Where links point: the phone address when phone access is on, else this Mac's.
    fn base_url(&self) -> String;
}

/// What only the satellite knows until P1b and P2 (phone push devices, the board on screen, connections):
/// `helper-facts`.
#[derive(Clone, Debug, Default)]
pub struct Facts {
    pub on_screen: bool,
    pub phone_devices: u64,
    pub connected: bool,
}
