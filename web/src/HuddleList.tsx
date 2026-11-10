import type { Huddle } from "./api";
import { FaceStack } from "./HelperFace";
import { brakeLabel, huddleCost, huddleTitle, members, quietLabel, roundTag, sortHuddles } from "./huddle";
import { fullTime, timeAgo } from "./time";
import { useNow } from "./useNow";
import { costText } from "./usage";

/**
 * Team's Huddles view: live huddles under "Live", the rest under "Earlier". Each row is the full title, then a small
 * line with the helpers' faces, when, any flags and the cost; a row opens that huddle in its host ticket's Huddle tab.
 */
export function HuddleList({ huddles, onOpen }: { huddles: Huddle[]; onOpen?: (ticketId: string, huddleId: string) => void }) {
  const now = useNow();
  const list = sortHuddles(huddles);
  if (!list.length) {
    return <div className="team-huddles"><div className="empty">No huddles on this board yet. Start one from a ticket's Huddle tab.</div></div>;
  }
  const live = list.filter((h) => h.status === "live");
  const earlier = list.filter((h) => h.status !== "live");
  const row = (h: Huddle) => {
    const helpers = members(h);
    const brake = brakeLabel(h);
    const quiet = quietLabel(h, now);
    const failed = helpers.filter((p) => p.status === "failed").length;
    const forYou = h.status === "closed" ? 0 : h.forYou ?? 0;
    const host = h.hostTitle ?? h.hostTicket;
    const round = roundTag(huddles, h);
    return (
      <button key={h.id} role="listitem" className={`huddle-row ${h.status}${brake ? " brake" : quiet ? " quiet" : ""}`} onClick={() => onOpen?.(h.hostTicket, h.id)}
        title={`Open ${round ? `${round.toLowerCase()} of ` : ""}the huddle of ${host}: ${huddleTitle(h)} · started ${fullTime(h.createdAt)}`}>
        <span className="hr-title">
          <span className="hr-dot" aria-label={brake ?? (quiet ? "quiet" : h.status)} />
          {host}{round && <span className="hr-round"> · {round}</span>}
        </span>
        <span className="hr-line">
          <FaceStack people={helpers} />
          <time dateTime={h.updatedAt} title={`Last activity ${fullTime(h.updatedAt)} · ${h.seq} ${h.seq === 1 ? "message" : "messages"}`}>{timeAgo(h.updatedAt)}</time>
          {forYou > 0 && <span className="for-you-pill">{forYou} for you</span>}
          {brake ? <span className="hr-brake">{brake}</span> : h.status === "stopped" && <span className="hr-brake">paused</span>}
          {quiet && <span className="hr-quiet">all quiet · {quiet}</span>}
          {failed > 0 && <span className="hb-failed">{failed} failed</span>}
          <span className="hr-cost" title="What the huddle's helpers have spent">{costText(huddleCost(h))}</span>
        </span>
      </button>
    );
  };
  return (
    <div className="team-huddles">
      {([["Live", live], ["Earlier", earlier]] as const).map(([label, rows]) => rows.length > 0 && (
        <section key={label} className="hr-group">
          <h3 className="hr-sec">{label}</h3>
          <div className="hr-list" role="list" aria-label={`${label} huddles`}>{rows.map(row)}</div>
        </section>
      ))}
    </div>
  );
}
