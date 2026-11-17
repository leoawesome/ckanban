//! Which outside service answers a request (board mode, P2), in Bun's route order: `/api/mcp*` and `/api/agents*`
//! (`src/api/connections.ts`), `/api/remote` (`remote.ts`), `/api/passes*` (`passes.ts`) and `POST /api/bug-report`,
//! `/api/bug-report/draft` (`system.ts`). `automation-call` is the schedules routes' (R10), which call
//! `SignIn::pass_call`.

use std::sync::Arc;

use super::agents_admin::AgentsAdmin;
use super::bugreport::BugReports;
use super::mcp::Mcp;
use super::phone::Phone;
use super::signin::SignIn;
use super::{Answer, Call};

pub struct Outside {
    pub mcp: Arc<Mcp>,
    pub signin: Arc<SignIn>,
    pub phone: Arc<Phone>,
    /// None when Bun's own command line can't be known for sure (`crate::agents::Agents::new`): Bun answers then.
    pub agents: Option<Arc<AgentsAdmin>>,
    pub bugs: Arc<BugReports>,
}

/// Whether one of the outside services answers this route (`parts`: the path after `/api/`).
pub fn claims(method: &str, parts: &[String], agents: bool) -> bool {
    match parts.first().map(String::as_str) {
        Some("mcp") | Some("passes") => true,
        Some("agents") => agents,
        Some("remote") => parts.len() == 1 && (method == "GET" || method == "POST"),
        Some("bug-report") => method == "POST" && parts.len() <= 2,
        _ => false,
    }
}

/// Whether the route may ask `userOnly` (so the router checks the caller first; the check runs `lsof`).
pub fn may_ask_user(method: &str, parts: &[String]) -> bool {
    parts.first().map(String::as_str) == Some("passes") && method != "GET"
}

impl Outside {
    pub async fn answer(&self, c: &Call<'_>) -> Option<Answer> {
        match c.parts.first().map(String::as_str) {
            Some("mcp") => self.mcp.answer(c).await,
            Some("agents") => {
                let mcp = self.mcp.clone();
                let refresh = move || mcp.refresh();
                self.agents.as_ref()?.answer(c, &refresh).await
            }
            Some("remote") => self.phone.answer(c).await,
            Some("passes") => self.signin.answer(c).await,
            Some("bug-report") => self.bugs.answer(c).await,
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> Vec<String> {
        s.split('/').map(str::to_string).collect()
    }

    #[test]
    fn claims_the_outside_routes_only() {
        assert!(claims("GET", &p("mcp"), true));
        assert!(claims("POST", &p("mcp/x/login"), true));
        assert!(claims("DELETE", &p("passes/abc"), true));
        assert!(claims("GET", &p("passes/oauth/callback"), true));
        assert!(claims("POST", &p("agents/claude/install"), true));
        assert!(!claims("POST", &p("agents/claude/install"), false));
        assert!(claims("GET", &p("remote"), true));
        assert!(!claims("PUT", &p("remote"), true));
        assert!(!claims("GET", &p("remote/x"), true));
        assert!(claims("POST", &p("bug-report/draft"), true));
        assert!(!claims("GET", &p("bug-report"), true));
        assert!(!claims("POST", &p("bug-report/a/b"), true));
        assert!(!claims("POST", &p("automation-call"), true));
        assert!(may_ask_user("POST", &p("passes")));
        assert!(!may_ask_user("GET", &p("passes/x/tools")));
        assert!(!may_ask_user("POST", &p("mcp")));
    }
}
