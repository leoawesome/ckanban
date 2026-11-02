// Proactive check-ins (Schedules → Proactive check-ins): a quiet schedule (Schedule.quiet) that checks, every work hour,
// what needs the user. The guides are default behaviour written as plain text: the setup chat copies the ones the user
// picks into the schedule's prompt, adapted to what they said, and the user changes any of it later by saying so.
// Nothing here is enforced by the board; the board only removes quiet runs and lists what a schedule raised (quiet.ts).
// A new guide is one more entry in GUIDES: no other code changes.

export interface CheckinGuide {
  key: string;
  /** Shown as a choice in the setup chat. */
  label: string;
  /** One line under the label. */
  summary: string;
  /** What the schedule's prompt says about this part, before the user's own changes. */
  text: string;
}

const MESSAGE_CATCH_UP = `## Message catch-up
Check these sources for what is new since the previous check: {sources}.
- Something needs the user when they are asked something, mentioned, assigned, requested for review, or a decision of theirs blocks someone. Skip bots, newsletters, channel chatter that doesn't involve them, and things they already answered.
- For each new thing that needs the user: raise a ticket (one per separate task; related messages on the same task share one). Put in it what happened in 2-3 plain sentences, the link to the source, and a suggested reply or next step. For Slack, also save the reply as a Slack draft in that conversation (slack_send_message_draft) so the user only has to press send. Never send a message, post or email yourself: drafts only.
- Urgent means: {urgent}.
- Follow-up on tickets this check-in raised that are still open (listed by the board below): {followUp}
- Board tickets waiting on the user: only tickets that are not from this check-in (leave out the open ones listed below and their runs). Mention one only if it has waited more than a day; one ticket for all of them is enough.`;

const FOLLOW_UP_ON = `
  - The user already handled it at the source (replied, reviewed, closed): move the ticket to done with move_ticket and a one-line comment saying what you saw.
  - New activity on the same thread or item: comment on that ticket with what is new, instead of raising a new one.
  - Still unanswered and urgent, or waiting 3 or more work hours: remind the user once, with a comment on the ticket and a notify_user message that names it. Before reminding, read the ticket's comments: if a reminder is already there, don't remind again.
  - Otherwise leave it alone.`;

const MEETING_PREP = `## Meeting prep
Look at the user's calendar ({calendar}) for meetings that start in the next 60 to 90 minutes.
- Skip meetings already prepared: a ticket titled "Prep: <meeting name> at <time>" exists, open or done (list_tickets with a search for "Prep:").
- Skip all-day events, focus blocks, events the user declined and events with no other attendees.
- For each meeting left, raise one ticket titled "Prep: <meeting name> at <HH:MM>" with: who is coming; open threads, issues and PRs with those people (from the sources above, if any); docs linked in the invite; and 2-4 points the user may want to raise or decide.`;

const OWN = `## {name}
{what}
- Raise a ticket when: {when}. Put in it what happened, a link to the source and what you suggest.`;

export const GUIDES: CheckinGuide[] = [
  {
    key: "catch-up", label: "Message catch-up",
    summary: "Slack, Linear, GitHub and the board: what needs a reply or a decision, with draft replies.",
    text: MESSAGE_CATCH_UP,
  },
  {
    key: "meeting-prep", label: "Meeting prep",
    summary: "A short brief before each meeting: who is coming, what is open with them, points to raise.",
    text: MEETING_PREP,
  },
  {
    key: "own", label: "Your own",
    summary: "Describe what to watch, or name one of your skills.",
    text: OWN,
  },
];

/** Defaults the setup chat starts from (the user can change each one). */
export const CHECKIN_DEFAULTS = {
  cron: "0 9-19 * * 1-5",
  hours: "every hour, weekdays 9:00 to 19:00",
  model: "sonnet",
  sources: "Slack DMs and mentions, Linear issues assigned to me, GitHub PRs waiting on my review, board tickets waiting on me",
  tag: "check-in",
};

/** The Planning chat of Schedules → Proactive check-ins: it sets up a quiet check-in schedule instead of shaping a ticket. */
export function checkinSetupPrompt(): string {
  const choices = GUIDES.map((g) => `- ${g.label}: ${g.summary}`).join("\n");
  const guides = GUIDES.map((g) => `### Guide "${g.label}"\n${g.text}`).join("\n\n");
  return `# This chat sets up proactive check-ins
This ticket exists to set up proactive check-ins for this board with the user, not to shape a ticket: one schedule that runs every work hour, checks what needs the user and raises only that as tickets in Review. Checks that find nothing leave no ticket (the schedule is quiet).
1. Start with \`ask_questions\`, one round: which guides to use (multiSelect, these options; "Message catch-up" recommended):
${choices}
   In the same round ask: work hours (recommended: ${CHECKIN_DEFAULTS.hours}), and for Message catch-up which sources (multiSelect, recommended: ${CHECKIN_DEFAULTS.sources}), what counts as urgent, and whether Claude may follow up on the tickets it raised (close handled ones, comment on new activity, remind once; recommended: yes). For "Your own", ask what to watch and when it should raise something, or which of their skills to run.
2. Check what this computer can reach for the picked sources, without changing anything: the tools you have in this session (Slack, Linear, Gmail, Google or Notion Calendar connectors and MCP servers), and \`gh auth status\` for GitHub. Tell the user in plain words what is missing and how to connect it: a claude.ai connector is switched on and authorised in claude.ai → Settings → Connectors; another MCP server in ⋯ → Connections → For Claude. A source you can't reach stays out of the prompt until it is connected: say so, don't stop.
3. Call \`list_schedules\`: if a check-in schedule (tag "${CHECKIN_DEFAULTS.tag}", or quiet with a check-in prompt) exists, offer to change it with \`update_schedule\` instead of making a second one.
4. Create ONE schedule with \`create_schedule\` that combines the picked guides: name "Proactive check-ins", title "Check-in {time}", cron from their hours (${CHECKIN_DEFAULTS.cron} for the default; 5 fields, local time), mode "auto", skipIfRunning true, quiet true, model "${CHECKIN_DEFAULTS.model}", tags ["${CHECKIN_DEFAULTS.tag}"]. The body is the prompt each run gets: a one-line goal ("Check what needs <the user> now and raise only that"), then each picked guide below with its {placeholders} filled in from the answers (for follow-up off, write "Don't follow up: leave them for the user."; for it on, use the follow-up list in the guide), the sources you could reach, and a closing line: "When the user gives feedback in a ticket this check-in raised (for example: ignore a channel, stop reminders, also check Gmail), change this schedule's prompt with update_schedule and say so in that ticket." Write it in plain words, self-contained: the runs don't see this chat.
5. Tell the user in 3-4 short lines what it will do, when it runs next, what it costs roughly (one ${CHECKIN_DEFAULTS.model} run per hour; checks that find nothing leave no ticket), and that they change it by telling Claude here or in any ticket it raises. Offer "Run now" in Schedules to try it.
Don't use propose_ticket in this chat, and don't create other tickets.

${guides}
{followUp} when on:${FOLLOW_UP_ON}`;
}
