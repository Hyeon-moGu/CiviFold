// Author: HyeonMo Gu
// Created: 2026-10-27

import Link from "next/link";
import { notFound } from "next/navigation";
import type { Candidate, Comparison, Decision } from "@/lib/pipeline/decide";
import type { GuardResult } from "@/lib/pipeline/guard";
import type { IntakeResult } from "@/lib/pipeline/intake";
import type { TriageResult } from "@/lib/pipeline/triage";
import { agentRecorded, recordedAgentReport } from "@/lib/demo/scenarios";
import { defaultMode } from "@/lib/meta/call";
import { AGENT_LIMITS } from "@/lib/pipeline/config";
import { VERIFIED } from "@/lib/pipeline/hybrid";
import { changedFacts, incidentDetail, incidentTitles, reportDetail, staleAnalysis, verifyRunning, WORDS_NOT_READ, wordsNotRead, type FactChange } from "@/lib/server/reports";
import { liveBudgetLeft, runtime } from "@/lib/server/runtime";
import type { Box, Channel, Label, RequestItem } from "@/lib/tools/types";
import { Fact, OpsLabel, Panel, UrgentTag, LABEL_TONE, pct, readable, VERDICT_TEXT } from "@/app/_ui/console";
import { cost, when } from "@/app/_ui/format";
import { LABEL_TEXT, SyntheticBadge } from "@/app/_ui/labels";
import { MaskedPhoto } from "@/app/_ui/photo";
import { Actions, RetryButton } from "./actions";
import { BriefCard, BriefProgress, BriefProvider, type StoredBrief } from "./brief";
import { summarize, TOOL_TEXT, verdictOf, type StepView, type Verdict } from "./steps";
import { ReanalyzeButton, VerifyProgress, VerifyProvider } from "./verify";

export const dynamic = "force-dynamic";
export const metadata = { title: "Report · Staff console · CiviFold" };

type Final = {
  label: Label;
  incident_id: string | null;
  rule_id: string;
  missing_info: RequestItem[];
  reason?: string; // set by a verification: the words of the rule (or agent) behind the answer
};
type Run = {
  id: number;
  analysis_id: number | null;
  trigger: unknown;
  status: string;
  requested_by: string;
  applied: boolean;
  steps: unknown;
  proposal?: unknown;
  guard: unknown;
  cost_usd: number;
  latency_ms: number;
};

const CHANNEL_TEXT: Record<Channel, string> = {
  photo: "Photo",
  photo_text: "Photo + text",
  text: "Text",
  voice: "Voice",
  voice_photo: "Voice + photo",
};

const STATUS_WORDS: Record<string, string> = {
  received: "Not checked yet",
  analyzing: "Checking",
  under_review: "Waiting for staff",
  needs_info: "Waiting for the resident",
  linked: "Linked by staff",
  new_incident: "Opened as an incident",
  dismissed: "Dismissed",
  failed: "Check failed",
  unavailable: "No prepared result",
};

// The suggestion in one sentence, as staff would say it.
// Suggestions that tie the report to an incident; HUMAN_REVIEW may name one without tying the report to it.
type Fix = "repair" | "cleanup";
const LINKS: ReadonlySet<Label> = new Set(["DUPLICATE", "LATE_REPORT", "ALREADY_RESOLVED", "POSSIBLE_RECURRENCE"]);
// A replayed agent run is shown one tool call at a time, this far apart.
const REPLAY_PACE_MS = 900;

// A dumped pile is cleared, not repaired: the word staff would use for what happened before the report.
function headline(label: Label, incident: string | null, fix: Fix): string {
  switch (label) {
    case "DUPLICATE":
      return `Same problem as ${incident}`;
    case "LATE_REPORT":
      return `Seen before ${incident} was fixed: a late report`;
    case "ALREADY_RESOLVED":
      return `Already fixed (${incident})`;
    case "NEW":
      return "A new problem";
    case "POSSIBLE_RECURRENCE":
      return `Back after the ${fix} of ${incident}?`;
    case "NEEDS_INFO":
      return "Waiting for one more thing from the resident";
    case "HUMAN_REVIEW":
      return "Needs a person to decide";
  }
}

export default async function ReportDetail({ params }: { params: Promise<{ id: string }> }) {
  const rt = await runtime();
  const detail = await reportDetail(rt, (await params).id);
  if (!detail) notFound();
  const { report, analysis, runs, questions, photos, incidents, incidentPhotos, imageFacts, segmentations, briefs } = detail;
  const triage = (analysis?.triage as TriageResult | null | undefined) ?? undefined;
  const fix: Fix = triage?.category === "trash" ? "cleanup" : "repair";
  const intake = (analysis?.intake as IntakeResult | null | undefined) ?? null;
  const unread = wordsNotRead(analysis?.errors);
  const decision = analysis?.decision as Decision | undefined;
  const final = analysis?.final as Final | undefined;
  const candidates = (analysis?.candidates as Candidate[] | undefined) ?? [];
  const comparisons = (analysis?.comparisons as Comparison[] | undefined) ?? [];
  const zoomed = Object.entries((analysis?.after_fix as Record<string, { problem_found: boolean; description?: string | null }> | null | undefined) ?? {});
  // Incident ids by name too ("the red hydrant with white caps"): staff read names, not ids, in texts written by models.
  const names = {
    ...photoNames(photos.map((p) => p.id), comparisons, Object.fromEntries(incidents.map((i) => [i.id, i.title]))),
    ...Object.fromEntries(incidents.map((i) => [i.id, `the ${i.title}`])),
    [report.id]: "this report",
  };

  // The incident the suggestion points at, else the nearest candidate.
  const focusId = final?.incident_id ?? candidates[0]?.incident_id ?? null;
  const focus = incidents.find((i) => i.id === focusId) ?? null;
  const focusComparisons = comparisons.filter((c) => c.incident_id === focusId && c.result);
  const best = [...focusComparisons].sort((a, b) => b.stage - a.stage || b.result!.asset_match.confidence - a.result!.asset_match.confidence)[0];
  const compared = Boolean(best);
  const candidatePhoto = best?.candidate_image_id ?? (focusId ? (incidentPhotos[focusId]?.id ?? null) : null);
  const seg = (id: string | null) => (id ? segmentations[id] : undefined);
  const candidateFacts = candidatePhoto ? (imageFacts[candidatePhoto] ?? (focusId ? incidentPhotos[focusId] : undefined)) : undefined;
  // The chip shows what the rules read; a fallback (crops asked, full photos used) is ignored by them too.
  const shownMatch = focusComparisons
    .filter((c) => !c.fallback)
    .sort((a, b) => b.stage - a.stage || b.result!.asset_match.confidence - a.result!.asset_match.confidence)[0];
  const decided = ["linked", "new_incident", "dismissed"].includes(report.status);
  // Whether the suggestion ties the report to this incident, or only compared it and kept it apart.
  const linked = focusId !== null && final !== undefined && LINKS.has(final.label) && final.incident_id === focusId;
  // P1 only says the resident was asked already; the rule before it says why the answer is not one click.
  const reasons = decision?.reasons ?? [];
  const lastReason = final?.reason ?? (reasons.at(-1)?.rule_id === "P1" && reasons.length > 1 ? `${reasons.at(-2)!.text} ${reasons.at(-1)!.text}` : reasons.at(-1)?.text);
  const waiting = analysis !== null && analysis !== undefined && report.status === "under_review";
  const answerChanged = Boolean(decision && final && (final.label !== decision.label || final.incident_id !== decision.incident_id));
  // An incident the suggestion relied on changed since (a repair recorded after it): analyze again, not verify.
  const changes = waiting ? changedFacts(candidates, incidents) : [];
  // A replay-only deployment replays an agent where it holds a recorded run, and otherwise runs it live while
  // today's budget holds a whole run (runMode); with neither, the button would fail. A report sent with the
  // access code runs its agents live, like its analysis.
  const replayOnly = defaultMode() === "cached" && !report.live;
  const [verifyReplays, briefReplays, liveLeft] = replayOnly
    ? await Promise.all([agentRecorded(rt, report, "verify"), agentRecorded(rt, report, "brief"), liveBudgetLeft(rt.database)])
    : [false, false, Infinity];
  const liveAgents = !replayOnly || liveLeft >= AGENT_LIMITS.max_usd;
  const [verifyRecorded, briefRecorded] = [verifyReplays || liveAgents, briefReplays || liveAgents];
  // Staff can ask the agent to check a closing suggestion that is waiting for them.
  const canVerify =
    waiting && changes.length === 0 && final !== undefined && VERIFIED.has(final.label) && analysis!.input !== null && runs.length < AGENT_LIMITS.max_runs_per_report;
  const verifiable = canVerify && verifyRecorded;
  const verifyLimit =
    waiting && changes.length === 0 && final !== undefined && VERIFIED.has(final.label) && analysis!.input !== null && runs.length >= AGENT_LIMITS.max_runs_per_report
      ? AGENT_LIMITS.max_runs_per_report
      : null;
  const verifying = verifyRunning(report);
  // Staff can ask for a case brief of any analysis that stored its inputs; it reads evidence and decides nothing.
  const canBrief = analysis !== null && analysis !== undefined && analysis.input !== null && !decided && briefs.length < AGENT_LIMITS.max_runs_per_report;
  const briefable = canBrief && briefRecorded;
  // A replayed report would replay the same brief again for the same analysis: no second button for that.
  const repeatBrief = briefReplays && (briefs as { analysis_id: number }[]).some((b) => b.analysis_id === analysis?.id);
  const agentsOff = (canVerify && !verifyRecorded) || (canBrief && !briefRecorded);
  // Where this demo case's recorded agent runs can be read instead, when this send cannot replay them.
  const agentsElsewhere = agentsOff ? await recordedAgentReport(rt, report.dataset_case_id) : null;
  const demoAnchor = report.dataset_case_id?.startsWith("demo:") ? `case-${report.dataset_case_id.slice(5).replace(":", "-")}` : null;
  // An incident staff opened from this report: a recurrence names the one it came back from.
  const opened = report.status === "new_incident" && report.incident_id ? ((await incidentDetail(rt, report.incident_id))?.incident ?? null) : null;
  const briefLimit = analysis && analysis.input !== null && !decided && briefs.length >= AGENT_LIMITS.max_runs_per_report ? AGENT_LIMITS.max_runs_per_report : null;
  const latestBrief = (briefs as StoredBrief[]).at(-1) ?? null;
  // The latest run's verdict, while its result is the suggestion on screen (no analysis since).
  const lastRun = (runs as Run[]).at(-1);
  const currentRunId = lastRun && analysis?.pipeline_config === "C_rules+verify" ? lastRun.id : null;
  // The incidents the run compared, by name: it may find one the fast path did not (one staff opened since, say).
  const comparedIds = [
    ...new Set(
      (runs as Run[])
        .flatMap((r) => r.steps as StepView[])
        .flatMap((s) => (s.ok && s.tool === "compare_images" ? [(s.data as { candidate_incident_id: string }).candidate_incident_id] : [])),
    ),
  ];
  // Incidents an agent only read about (a brief reads an incident's history) are named too.
  const readIds = JSON.stringify([latestBrief, runs]).match(/\binc_[a-z0-9_]+/g) ?? [];
  const incidentNames = await incidentTitles(rt, [
    ...new Set([...comparedIds, ...readIds, ...changes.map((c) => c.incident_id), ...(report.incident_id ? [report.incident_id] : []), ...(opened?.recurrence_of ? [opened.recurrence_of] : [])]),
  ]);
  const incidentLabels = {
    ...Object.fromEntries(incidents.map((i) => [i.id, `the ${i.title}`])),
    ...Object.fromEntries(Object.entries(incidentNames).map(([id, title]) => [id, `the ${title}`])),
  };
  const verdict: Verdict | null =
    lastRun && lastRun.applied && lastRun.requested_by === "staff" && analysis?.pipeline_config === "C_rules+verify" && final && decision
      ? verdictOf({
          status: lastRun.status,
          guard: lastRun.guard as GuardResult | null,
          steps: lastRun.steps as StepView[],
          before: { label: (lastRun.trigger as { label: Label }).label, incident_id: decision.incident_id },
          after: final,
          incidentNames,
        })
      : null;
  // Compared and judged a different place or fixture: shown as a checked-and-excluded note, not as a match.
  // Not while the resident is asked: then the comparisons were unsure, and "kept apart" would contradict the question.
  const ruledOut = !linked && shownMatch?.result?.asset_match.verdict === "different" && final?.label !== "NEEDS_INFO";
  const focusDistance = candidates.find((c) => c.incident_id === focusId)?.distance_m;
  const suggestedIncident = incidents.find((i) => i.id === final?.incident_id);
  // A report photo compared with the incident's, and not ruled out: the comparison is the evidence, shown whole.
  const sideBySide = !ruledOut && photos.length > 0 && compared;

  return (
    <main className="mx-auto max-w-[1400px] px-4 pb-16 pt-4">
      {/* Top bar */}
      <div className="flex flex-wrap items-center gap-3 border-b border-ops-line pb-3">
        <Link href="/admin" className="text-xs text-ops-dim hover:text-white">
          ← Queue
        </Link>
        <h1 className="font-mono text-lg font-semibold tracking-wider text-white">{report.tracking_code}</h1>
        {report.urgent && <UrgentTag />}
        <span className="rounded border border-ops-line px-1.5 py-0.5 text-[11px] text-ops-dim">{CHANNEL_TEXT[report.channel as Channel]}</span>
        <span className="text-xs text-ops-dim">{STATUS_WORDS[report.status] ?? report.status.replace("_", " ")}</span>
        {analysis && (
          <span className="ml-auto font-mono text-[11px] text-ops-dim">
            {/* After a staff-requested check the latest analysis is the check's, its cost the agent's run included. */}
            {analysis.pipeline_config === "C_rules+verify" ? "check" : "analysis"} {cost(analysis.cost_usd)} · {(analysis.latency_ms / 1000).toFixed(1)}s ·{" "}
            {/* A report with only typed words carries no media, so it is neither a sample photo nor an upload. */}
            {report.is_synthetic ? "synthetic sample" : photos.some((p) => p.dataset_image_id?.startsWith("sf_")) ? "San Francisco 311 photo" : report.channel === "text" ? "typed message" : "resident upload"}
          </span>
        )}
      </div>

      {report.urgent && (
        <div className="mt-4 flex items-start gap-3 rounded-lg border border-red-500/50 bg-red-500/10 px-4 py-3 text-sm">
          <span className="mt-0.5 h-2 w-2 shrink-0 animate-pulse rounded-full bg-red-500" />
          <div>
            <p className="font-semibold text-red-200">
              Possible emergency
              {intake?.emergency_reason ? `: ${intake.emergency_reason}` : ""}
            </p>
            <p className="mt-0.5 text-red-200/80">
              Act on it now. The resident was told to call 911; matching to existing incidents was skipped.
            </p>
          </div>
        </div>
      )}
      {staleAnalysis(report) && (
        <Notice>
          The automatic check started {when(report.claimed_at)} and never finished. Decide from the report, or run it again.
          <RetryButton reportId={report.id} />
        </Notice>
      )}
      {report.status === "failed" && (
        <Notice>
          The automatic check failed
          {analysis ? "; the result below is from an earlier analysis" : ""}.
          {report.error && <span className="mt-1 block font-mono text-[11px] text-ops-dim">{report.error}</span>}
          <RetryButton reportId={report.id} />
        </Notice>
      )}
      {report.status === "received" && (
        <Notice>
          The automatic check has not run. It starts from the resident&apos;s tracking page, which has not been opened. Run it here, or decide from the report.
          <RetryButton reportId={report.id} text="Run the automatic check" />
        </Notice>
      )}
      {report.status === "analyzing" && !staleAnalysis(report) && <Notice>The automatic check is running. Reload in a moment.</Notice>}

      {!analysis && report.incident_id && ["new_incident", "linked"].includes(report.status) ? (
        // The demo's starting history: incidents staff opened before the demo begins, entered as already decided.
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <Panel title="Starting incident" aside={`reported ${when(report.submitted_at)}`}>
            {photos[0] && (
              <MaskedPhoto
                variant="ops"
                src={`/api/images/${photos[0].id}?w=960`}
                width={photos[0].width}
                height={photos[0].height}
                synthetic={photos[0].is_synthetic}
              />
            )}
          </Panel>
          <Panel title="Why there is no analysis">
            <p className="text-sm text-ops-text">
              Staff opened{" "}
              <Link
                href={`/admin/incidents/${report.incident_id}`}
                className="text-white underline decoration-ops-dim underline-offset-2 hover:decoration-white"
              >
                {incidentLabels[report.incident_id] ?? "an incident"}
              </Link>{" "}
              from this report before the demo started. It is part of the starting history that new reports are compared with, so it never went through the
              automatic check.
            </p>
          </Panel>
        </div>
      ) : !analysis ? (
        <p className="mt-10 text-sm text-ops-dim">
          {report.status === "unavailable"
            ? "No prepared result for this report in the public demo."
            : report.status === "failed"
              ? "Decide from the report itself."
              : "Not analyzed yet."}
        </p>
      ) : (
        <VerifyProvider reportId={report.id} paceMs={verifyReplays ? REPLAY_PACE_MS : 0}>
        <BriefProvider reportId={report.id} paceMs={briefReplays ? REPLAY_PACE_MS : 0}>
          {/* Verdict and decision: one band that stays under the header while staff look through the evidence. */}
          {/* Sticky only where the screen is tall enough that the band does not cover the photos it decides on. */}
          <div className="z-[999] -mx-4 mt-4 bg-ops-bg/95 px-4 py-2 backdrop-blur md:[@media(min-height:900px)]:sticky md:top-[45px]">
            <Actions
              caution={verdict?.kind === "against"}
              status={verdict && !decided && changes.length === 0 ? <VerdictLine verdict={verdict} /> : null}
              ring={report.urgent ? "ring-red-500/60" : final ? LABEL_TONE[final.label].ring : ""}
              reportId={report.id}
              analysisId={analysis.id}
              final={final ?? null}
              focusId={focusId}
              askFor={photos.length === 0 ? "photo" : "wider_context"}
              decided={decided}
              agentsOff={agentsOff}
              agentsElsewhere={agentsElsewhere === report.id ? null : agentsElsewhere}
              demoAnchor={demoAnchor}
              decidedNote={decidedNote(report.status, report.incident_id, [...incidents, ...Object.entries(incidentNames).map(([id, title]) => ({ id, title }))], opened?.recurrence_of ?? null)}
              stale={changes.length > 0}
              verify={verifiable ? { analysisId: analysis!.id, running: verifying, again: runs.length > 0 } : null}
              verifyLimit={verifyLimit}
              brief={briefable && !repeatBrief ? { analysisId: analysis!.id, again: briefs.length > 0 } : null}
              briefLimit={briefLimit}
            >
              {final && (
                <>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <OpsLabel label={final.label} />
                    <p className="text-lg font-semibold tracking-tight text-white">{headline(final.label, suggestedIncident?.title ? `the ${suggestedIncident.title}` : final.incident_id, fix)}</p>
                  </div>
                  {/* The headline names the suggested incident; the sentence under it calls it "the incident". */}
                  {lastReason && (
                    <p className="mt-1 text-sm text-ops-text">{byName(final.incident_id ? readable(lastReason).replaceAll(final.incident_id, "the incident") : readable(lastReason), incidentLabels)}</p>
                  )}
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1">
                    {final.incident_id && (
                      <Link
                        href={`/admin/incidents/${final.incident_id}`}
                        className="text-xs text-ops-dim underline decoration-ops-line underline-offset-2 hover:text-white hover:decoration-white"
                      >
                        <span className="text-ops-text" title={final.incident_id}>
                          {suggestedIncident?.title ? `The ${suggestedIncident.title}` : final.incident_id}
                        </span>{" "}
                        →
                      </Link>
                    )}
                    {/* The confidence is the fast path's; once verification changed the answer it is not this answer's. A rule
                        that decided without any comparison (no photo, an emergency) has no model confidence to show. */}
                    {decision && !answerChanged && decision.confidence > 0 && comparisons.some((c) => c.result) && <Confidence value={decision.confidence} />}
                  </div>
                  {decision && answerChanged && (
                    <p className="mt-1 text-xs text-ops-dim">
                      Before verification: {LABEL_TEXT[decision.label]} (fast path, model confidence {pct(decision.confidence)})
                      <span className="ml-2 font-mono text-[10px]">
                        {decision.rule_id} → {final.rule_id}
                      </span>
                    </p>
                  )}
                </>
              )}
            </Actions>
            <VerifyProgress maxSteps={AGENT_LIMITS.max_steps} maxMs={AGENT_LIMITS.max_ms} runningSince={verifying ? String(report.verify_claimed_at) : null} live={report.live ? "always" : !verifyReplays ? "maybe" : null} names={incidentLabels} />
            <BriefProgress maxSteps={AGENT_LIMITS.max_steps} maxMs={AGENT_LIMITS.max_ms} live={report.live ? "always" : !briefReplays ? "maybe" : null} names={incidentLabels} />
          </div>
          {changes.length > 0 && <OutOfDate changes={changes} reportId={report.id} analysisId={analysis.id} names={incidentLabels} />}

          <div className="mt-2 grid gap-4 xl:grid-cols-[1fr_380px]">
            <div className="min-w-0 space-y-4">
              {/* Evidence: both photos side by side when the suggestion rests on a comparison with this incident. */}
              {sideBySide && focus && candidatePhoto && best?.result ? (
                <PhotoComparison
                  report={{ observed: report.observed_at, photos, newImageId: best.new_image_id }}
                  incident={{ id: focus.id, title: focus.title, status: focus.status, resolved: focus.resolved_at, photo: candidatePhoto, facts: candidateFacts }}
                  comparison={best}
                  linked={linked}
                  segmentations={segmentations}
                  names={names}
                />
              ) : (
                <div className={`grid gap-4 ${ruledOut ? "lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]" : "lg:grid-cols-2"}`}>
                  <Panel title="New report" aside={`seen ${when(report.observed_at)}`}>
                    {photos.length === 0 ? (
                      <div className="flex min-h-32 items-center justify-center rounded-md border border-dashed border-ops-line p-6 text-center text-sm text-ops-dim">
                        {noPhotoText(decision?.reasons.at(-1)?.rule_id)}
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <MaskedPhoto
                          variant="ops"
                          src={`/api/images/${photos[0]!.id}?w=960`}
                          width={photos[0]!.width}
                          height={photos[0]!.height}
                          maskPath={seg(photos[0]!.id)?.mask_svg_path}
                          box={seg(photos[0]!.id)?.box as Box | null}
                          synthetic={photos[0]!.is_synthetic}
                        />
                        {/* The cut-outs SAM made of this report, as the side-by-side comparison shows them. */}
                        {seg(photos[0]!.id)?.object_crop_id && <Crops seg={seg(photos[0]!.id)!} synthetic={photos[0]!.is_synthetic} />}
                        {photos.length > 1 && (
                          <div className="grid grid-cols-3 gap-2">
                            {photos.slice(1).map((p) => (
                              <MaskedPhoto
                                key={p.id}
                                variant="ops"
                                src={`/api/images/${p.id}?w=480`}
                                width={p.width}
                                height={p.height}
                                maskPath={seg(p.id)?.mask_svg_path}
                                box={seg(p.id)?.box as Box | null}
                                synthetic={p.is_synthetic}
                                caption="sent when asked"
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </Panel>
                  {ruledOut && focus && shownMatch?.result ? (
                    <Panel
                      title={`Ruled out: the ${focus.title ?? focus.id}`}
                      aside={<MatchChip verdict="different" confidence={shownMatch.result.asset_match.confidence} crops={shownMatch.stage === 2} />}
                    >
                      <p className="text-sm text-ops-text">
                        The nearest {focus.title ?? "incident"}
                        {focusDistance !== undefined ? `, ${Math.round(focusDistance)} m away,` : ""} is a different place or fixture, so this report was kept
                        apart from it.
                      </p>
                      <ul className="mt-3 space-y-1.5 text-[13px] text-ops-dim">
                        {shownMatch.result.asset_match.evidence.slice(0, 3).map((e, i) => (
                          <li key={i} className="flex gap-2">
                            <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-rose-300" />
                            {photoWords(e, focus.id)}
                          </li>
                        ))}
                      </ul>
                      {candidatePhoto && (
                        <details className="group mt-4" open>
                          <summary className="cursor-pointer select-none text-[13px] font-medium text-white underline decoration-ops-dim underline-offset-2 hover:decoration-white">
                            <span className="group-open:hidden">Show its photo</span>
                            <span className="hidden group-open:inline">Hide its photo</span>
                          </summary>
                          <div className="mt-3">
                            <MaskedPhoto
                              variant="ops"
                              src={`/api/images/${candidatePhoto}?w=480`}
                              width={candidateFacts?.width ?? 1920}
                              height={candidateFacts?.height ?? 1280}
                              maskPath={seg(candidatePhoto)?.mask_svg_path}
                              box={seg(candidatePhoto)?.box as Box | null}
                              synthetic={candidateFacts?.is_synthetic ?? false}
                              caption={`The ${focus.title ?? focus.id}, not this report`}
                            />
                          </div>
                        </details>
                      )}
                    </Panel>
                  ) : (
                    <Panel
                      title={
                        focus
                          ? linked
                            ? `${report.status === "linked" ? "Linked" : "Suggested"}: the ${focus.title ?? "incident"}`
                            : compared
                              ? `Compared with the ${focus.title ?? "incident"}`
                              : `Nearest incident: the ${focus.title ?? "incident"}`
                          : decision?.reasons.at(-1)?.rule_id === "R0"
                            ? "Not searched yet"
                            : "No incident nearby"
                      }
                      aside={
                        focus ? (
                          <span className="flex items-center gap-2">
                            {shownMatch?.result && (
                              <MatchChip
                                verdict={shownMatch.result.asset_match.verdict}
                                confidence={shownMatch.result.asset_match.confidence}
                                crops={shownMatch.stage === 2}
                              />
                            )}
                            {`${focus.status}${compared ? "" : " · not compared"}`}
                          </span>
                        ) : undefined
                      }
                    >
                      {candidatePhoto ? (
                        <MaskedPhoto
                          variant="ops"
                          src={`/api/images/${candidatePhoto}?w=960`}
                          width={candidateFacts?.width ?? 1920}
                          height={candidateFacts?.height ?? 1280}
                          maskPath={seg(candidatePhoto)?.mask_svg_path}
                          box={seg(candidatePhoto)?.box as Box | null}
                          synthetic={candidateFacts?.is_synthetic ?? false}
                          caption={focus?.title}
                        />
                      ) : (
                        <div className="flex min-h-32 items-center justify-center rounded-md border border-dashed border-ops-line p-6 text-center text-sm text-ops-dim">
                          {focus
                            ? "No photo of this incident to show."
                            : decision?.reasons.at(-1)?.rule_id === "R0"
                              ? "Not searched yet: a usable photo comes first."
                              : "Nothing of this kind within the search radius."}
                        </div>
                      )}
                    </Panel>
                  )}
                </div>
              )}

              <PipelineTrace
                hasMessage={Boolean(report.description || report.audio_path)}
                hasPhoto={photos.length > 0}
                intake={intake}
                unread={unread !== null}
                triage={triage}
                candidates={candidates}
                photoFound={photos[0] ? seg(photos[0].id)?.found : undefined}
                comparisons={focusComparisons}
                decision={decision}
                runs={(runs as Run[]).filter((r) => r.id === currentRunId)}
                final={final}
                verifiable={verifiable}
                verifyLimit={verifyLimit}
              />

              <TimeBar
                observed={report.observed_at}
                submitted={report.submitted_at}
                created={ruledOut ? null : (focus?.created_at ?? null)}
                resolved={ruledOut ? null : (focus?.resolved_at ?? null)}
                fix={fix}
              />

              {candidates.length > 0 && (
                <Panel title="Nearby incidents checked" aside={`${candidates.length} within the search radius`}>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[640px] text-[13px]">
                      <thead className="text-left text-xs text-ops-dim">
                        <tr>
                          <th className="pb-2 font-normal">Incident</th>
                          <th className="pb-2 font-normal">Status</th>
                          <th className="pb-2 font-normal">Distance</th>
                          <th className="pb-2 font-normal">Whole photo</th>
                          <th className="pb-2 font-normal">Cut-out (SAM)</th>
                          <th className="pb-2 font-normal">Result</th>
                        </tr>
                      </thead>
                      <tbody className="font-mono">
                        {candidates.map((c) => {
                          const verdict = (stage: 1 | 2) => {
                            const rs = comparisons.filter((x) => x.incident_id === c.incident_id && x.stage === stage && x.result && !x.fallback);
                            const top = rs.sort((a, b) => b.result!.asset_match.confidence - a.result!.asset_match.confidence)[0];
                            if (!top) return <span className="text-ops-dim">n/a</span>;
                            const v = top.result!.asset_match.verdict;
                            const tone = v === "same" ? "text-white" : v === "different" ? "text-rose-300" : "text-amber-300";
                            return <span className={tone}>{`${VERDICT_TEXT[v] ?? v} · ${pct(top.result!.asset_match.confidence)}`}</span>;
                          };
                          const ran = comparisons.some((x) => x.incident_id === c.incident_id && x.result);
                          const result =
                            final && LINKS.has(final.label) && final.incident_id === c.incident_id ? (
                              final.label === "POSSIBLE_RECURRENCE" ? (
                                <span className="text-rose-300">possible recurrence</span>
                              ) : (
                                <span className="text-sky-300">{report.status === "linked" ? "merged" : "suggested merge"}</span>
                              )
                            ) : final?.incident_id === c.incident_id ? (
                              <span className="text-amber-300">staff decides</span>
                            ) : ran && comparisons.some((x) => x.incident_id === c.incident_id && x.result?.asset_match.verdict === "uncertain") ? (
                              // An unsure comparison is not a decision to keep the report apart.
                              <span className="text-amber-300">unsure</span>
                            ) : ran ? (
                              <span className="text-ops-text">kept apart</span>
                            ) : (
                              <span className="text-ops-dim">not compared</span>
                            );
                          return (
                            <tr key={c.incident_id} className={`border-t border-ops-line ${c.incident_id === focusId ? "bg-ops-raised" : ""}`}>
                              <td className="py-1.5">
                                <Link
                                  href={`/admin/incidents/${c.incident_id}`}
                                  className="text-white underline decoration-ops-dim underline-offset-2 hover:decoration-white"
                                >
                                  {incidents.find((i) => i.id === c.incident_id)?.title ?? c.incident_id}
                                </Link>
                              </td>
                              <td className="text-ops-dim">{c.status}</td>
                              <td className="tabular-nums">{Math.round(c.distance_m)} m</td>
                              <td>{verdict(1)}</td>
                              <td>{verdict(2)}</td>
                              <td className="font-sans">{result}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </Panel>
              )}
            </div>

            {/* Reasons column */}
            <aside className="space-y-4">
              {(decision?.reasons.some((r) => r.text.trim()) || zoomed.length > 0 || best) && (
              <Panel title="Why">
                {/* The rules read in order; the last one decided. Rule ids stay for whoever checks the decision table. */}
                <ol className="space-y-2 text-[13px]">
                  {decision?.reasons.filter((r) => r.text.trim()).map((r, i, all) => {
                    const last = i === all.length - 1;
                    return (
                      <li key={i} title={`Rule ${r.rule_id}`} className={`flex gap-2.5 ${last ? "rounded-md bg-ops-raised px-2.5 py-2" : "px-2.5"}`}>
                        <span className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${last ? "bg-white" : "bg-ops-dim"}`} />
                        <span className="min-w-0 flex-1">
                          {last && <span className="mb-0.5 block text-xs text-ops-dim">Result</span>}
                          <span className={last ? "font-medium text-white" : "text-ops-text"}>{byName(readable(r.text), incidentLabels)}</span>
                        </span>
                      </li>
                    );
                  })}
                </ol>
                {/* The zoomed after-fix check: what it found is the evidence a recurrence (R7z) rests on. */}
                {zoomed.length > 0 && (
                  <ul className="mt-3 space-y-1.5 text-[13px]">
                    {zoomed.map(([imageId, z]) => (
                      <li key={imageId} className="flex gap-2.5 px-2.5">
                        <span className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${z.problem_found ? "bg-rose-300" : "bg-emerald-300"}`} />
                        <span className="text-ops-text">
                          Zoomed check of {names[imageId] ?? "a photo"}: {z.problem_found ? `a problem found${z.description ? `, ${z.description}` : ""}` : "no problem found"}.
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {best?.result && !sideBySide && !ruledOut && (
                  <>
                    <h3 className="mt-4 text-[13px] font-medium text-ops-text">What the photos show</h3>
                    <p className="mt-1 text-[11px] text-ops-dim">
                      From the {best.stage === 2 && !best.fallback ? "cut-out" : "whole photo"} comparison of {names[best.new_image_id] ?? "the report's photo"} with{" "}
                      {names[best.candidate_image_id] ?? "the incident's photo"}, model confidence {pct(best.result.asset_match.confidence)}.
                    </p>
                    <ul className="mt-2 space-y-1.5 text-[13px]">
                      {[...best.result.asset_match.evidence, ...best.result.damage.evidence].map((e, i) => (
                        <li key={i} className="flex gap-2">
                          <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-ops-dim" />
                          {photoWords(e, best.incident_id)}
                        </li>
                      ))}
                    </ul>
                    <p className="mt-3 border-t border-ops-line pt-3 text-xs text-ops-dim">{best.result.summary}</p>
                  </>
                )}
              </Panel>
              )}

              {/* What the agents found sits beside the evidence, never between the decision and the photos. */}
              {verdict && !decided && changes.length === 0 && <VerdictCard verdict={verdict} />}
              {latestBrief && <BriefCard stored={latestBrief} stale={latestBrief.analysis_id !== analysis.id} names={{ ...names, ...incidentLabels }} />}

              {(report.description || report.audio_path || intake) && (
                <Panel title="Resident's message">
                  {report.description && <p className="text-sm">“{report.description}”</p>}
                  {unread && <p className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[12px] text-amber-200">{WORDS_NOT_READ[unread]}</p>}
                  {report.audio_path && (
                    <div className="mt-2 space-y-2">
                      <audio controls src={`/api/reports/${report.id}/audio`} className="h-9 w-full" />
                      <p className="text-[13px] text-ops-dim">
                        <span className="text-xs">Transcribed by Muse Voice Transcribe</span>
                        <br />
                        {report.transcript ? `“${report.transcript}”` : "not yet transcribed"}
                      </p>
                    </div>
                  )}
                  {intake && (
                    <div className="mt-3 border-t border-ops-line pt-2">
                      <Fact k="kind" v={intake.category.replace("_", " ")} />
                      {intake.problem && <Fact k="problem" v={intake.problem} />}
                      {intake.place && <Fact k="place" v={intake.place} />}
                      {intake.observed_time && <Fact k="seen" v={intake.observed_time} />}
                      {intake.landmarks.length > 0 && <Fact k="landmarks" v={intake.landmarks.join(", ")} />}
                    </div>
                  )}
                </Panel>
              )}

              {questions.length > 0 && (
                <Panel title="Questions to the resident">
                  {questions.map((q) => (
                    <div key={q.id} className="text-[13px]">
                      <span className={`text-xs ${q.status === "pending" ? "text-amber-300" : "text-ops-dim"}`}>
                        {q.source === "staff"
                          ? "asked by staff"
                          : q.source === "agent"
                            ? "asked by the agent"
                            : `asked by rule ${q.reason_for_staff}`}{" "}
                        · {q.status}
                      </span>
                      <p className="mt-0.5">{q.question}</p>
                    </div>
                  ))}
                </Panel>
              )}

              {runs.length > 0 && <Investigation runs={runs as Run[]} currentRunId={currentRunId} names={incidentLabels} />}
            </aside>
          </div>
        </BriefProvider>
        </VerifyProvider>
      )}
    </main>
  );
}

// The comparison's own reading. "Same" is neutral: a duplicate and a recurrence both need it; a sure "different"
// forbids folding onto this incident (red).
function MatchChip({ verdict, confidence, crops }: { verdict: string; confidence: number; crops: boolean }) {
  const tone =
    verdict === "same"
      ? "text-white ring-zinc-500/60 bg-white/5"
      : verdict === "different"
        ? "text-rose-300 ring-rose-500/50 bg-rose-500/10"
        : "text-amber-300 ring-amber-500/40 bg-amber-500/10";
  return (
    <span
      className={`whitespace-nowrap rounded px-1.5 py-0.5 font-mono text-[10px] normal-case tracking-normal ring-1 ring-inset ${tone}`}
      title={`Muse Spark compared ${crops ? "the SAM cut-outs" : "the whole photos"}: "${VERDICT_TEXT[verdict] ?? verdict}". ${pct(confidence)} is the model's own confidence in that verdict, not a measured accuracy or a similarity score.`}
    >
      {crops ? "cut-out" : "whole photo"}: {VERDICT_TEXT[verdict] ?? verdict} · model {pct(confidence)}
    </span>
  );
}

// What a staff decision did, in the words the band shows after it.
function decidedNote(status: string, incidentId: string | null, near: Array<{ id: string; title: string | null }>, recurrenceOf: string | null) {
  if (status === "linked" && incidentId) {
    const title = near.find((i) => i.id === incidentId)?.title;
    return (
      <>
        Linked to{" "}
        <Link href={`/admin/incidents/${incidentId}`} title={incidentId} className="text-white underline decoration-emerald-400/60 underline-offset-2 hover:decoration-white">
          {title ? `the ${title}` : "the incident"}
        </Link>
        .
      </>
    );
  }
  if (status === "new_incident" && recurrenceOf) {
    const was = near.find((i) => i.id === recurrenceOf)?.title;
    return `Opened as a recurrence of ${was ? `the ${was}` : "an earlier incident"}, kept apart from the fixed incident.`;
  }
  if (status === "new_incident") return "Opened as a new incident.";
  if (status === "dismissed") return "Dismissed.";
  return null;
}

type PhotoRow = { id: string; width: number; height: number; is_synthetic: boolean };
type SegRow = { noun_phrase: string; mask_svg_path: string | null; box: unknown; object_crop_id: string | null; context_crop_id: string | null };

// The comparison the suggestion rests on, read left to right: both photos, the cut-outs the model compared,
// and what it said about the fixture and about the problem. Dates are not here on purpose; the rules add them.
function PhotoComparison({
  report,
  incident,
  comparison,
  linked,
  segmentations,
  names,
}: {
  report: { observed: string; photos: PhotoRow[]; newImageId: string };
  incident: { id: string; title: string | null; status: string; resolved: string | null; photo: string; facts: { width: number; height: number; is_synthetic: boolean } | undefined };
  comparison: Comparison;
  linked: boolean;
  segmentations: Record<string, SegRow | undefined>;
  names: Record<string, string>;
}) {
  const result = comparison.result!;
  const seg = (id: string) => segmentations[id];
  const crops = comparison.stage === 2 && !comparison.fallback;
  const reportCrops = crops ? seg(report.newImageId) : undefined;
  const incidentCrops = crops ? seg(comparison.candidate_image_id) : undefined;
  const showCrops = Boolean(reportCrops?.object_crop_id && incidentCrops?.object_crop_id);
  const [first, ...more] = report.photos;
  const fixed = incident.status === "resolved" || incident.status === "closed";
  const words = (text: string) => photoWords(text, incident.id);
  return (
    <Panel
      title={`Compared with the ${incident.title ?? incident.id}${linked ? ", the incident it suggests" : ""}`}
      aside={<MatchChip verdict={result.asset_match.verdict} confidence={result.asset_match.confidence} crops={crops} />}
    >
      <div className="grid gap-4 md:grid-cols-2">
        <div className="min-w-0 space-y-2">
          <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
            <span className="font-medium text-white">This report</span>
            <span className="text-xs text-ops-dim">seen {when(report.observed)}</span>
          </p>
          <MaskedPhoto
            variant="ops"
            className="mx-auto"
            style={upToLandscape(first!.width, first!.height)}
            src={`/api/images/${first!.id}?w=960`}
            width={first!.width}
            height={first!.height}
            maskPath={seg(first!.id)?.mask_svg_path}
            box={seg(first!.id)?.box as Box | null}
            synthetic={first!.is_synthetic}
          />
          {more.length > 0 && (
            <div className="grid grid-cols-3 gap-2">
              {more.map((p) => (
                <MaskedPhoto
                  key={p.id}
                  variant="ops"
                  src={`/api/images/${p.id}?w=480`}
                  width={p.width}
                  height={p.height}
                  maskPath={seg(p.id)?.mask_svg_path}
                  box={seg(p.id)?.box as Box | null}
                  synthetic={p.is_synthetic}
                  caption="sent when asked"
                />
              ))}
            </div>
          )}
          {showCrops && <Crops seg={reportCrops!} synthetic={first!.is_synthetic} />}
        </div>
        <div className="min-w-0 space-y-2">
          <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
            <Link
              href={`/admin/incidents/${incident.id}`}
              title={incident.id}
              className="font-medium text-white underline decoration-ops-line underline-offset-2 hover:decoration-white"
            >
              The incident on file
            </Link>
            <span className="text-xs text-ops-dim">{[incident.title, fixed ? `fixed ${when(incident.resolved)}` : incident.status].filter(Boolean).join(" · ")}</span>
          </p>
          <MaskedPhoto
            variant="ops"
            className="mx-auto"
            style={upToLandscape(incident.facts?.width ?? 1920, incident.facts?.height ?? 1280)}
            src={`/api/images/${incident.photo}?w=960`}
            width={incident.facts?.width ?? 1920}
            height={incident.facts?.height ?? 1280}
            maskPath={seg(incident.photo)?.mask_svg_path}
            box={seg(incident.photo)?.box as Box | null}
            synthetic={incident.facts?.is_synthetic ?? false}
          />
          {showCrops && <Crops seg={incidentCrops!} synthetic={incident.facts?.is_synthetic ?? false} />}
        </div>
      </div>
      <div className="mt-4 grid gap-4 border-t border-ops-line pt-4 md:grid-cols-2">
        <Finding question="Same place or fixture?" verdict={result.asset_match.verdict} lines={result.asset_match.evidence.map(words)} />
        <Finding question="Same problem?" verdict={result.damage.same_damage_signature} lines={result.damage.evidence.map(words)} />
      </div>
      <p className="mt-3 text-xs text-ops-dim">
        Muse Spark compared {crops ? "the SAM 3.1 cut-outs" : "the whole photos"} of {names[comparison.new_image_id] ?? "the report's photo"} and{" "}
        {names[comparison.candidate_image_id] ?? "the incident's photo"} without seeing any dates. {words(result.summary)}
      </p>
    </Panel>
  );
}

// The two cut-outs SAM made from one photo: what triage named (a hydrant, but for a place problem the pothole or
// pile itself), and a crop three times its size that keeps the landmarks around it.
function Crops({ seg, synthetic }: { seg: SegRow; synthetic: boolean }) {
  const parts = [
    { what: seg.noun_phrase, object: true, id: seg.object_crop_id },
    { what: "surroundings", object: false, id: seg.context_crop_id },
  ].filter((p): p is { what: string; object: boolean; id: string } => p.id !== null);
  return (
    <div className="flex gap-2">
      {parts.map((p) => (
        <figure key={p.id} className={p.object ? "w-28 shrink-0" : "min-w-0 flex-1"}>
          <div className="relative h-28 overflow-hidden rounded-md border border-ops-line bg-black">
            {/* eslint-disable-next-line @next/next/no-img-element -- crops come from our own image route, already sized */}
            <img src={`/api/images/${p.id}?w=480`} alt={`SAM 3.1 cut-out: ${p.what}`} className={`h-full w-full ${p.object ? "object-contain" : "object-cover"}`} />
            {/* Bottom corner: the top of a fixture (caps, dome, lamp) is usually what tells two apart. */}
            {synthetic && (
              <span className="absolute bottom-1 left-1">
                <SyntheticBadge />
              </span>
            )}
          </div>
          <figcaption className="mt-1 truncate text-[11px] text-ops-dim" title={p.object ? `SAM 3.1 cut out "${p.what}", with a 10% margin` : "Three times the size of the cut-out, so the landmarks around it stay in view"}>
            Cut-out: {p.what}
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

function Finding({ question, verdict, lines }: { question: string; verdict: string; lines: string[] }) {
  const tone = verdict === "same" ? "text-white" : verdict === "different" ? "text-rose-300" : "text-amber-300";
  return (
    <div>
      <p className="flex items-baseline gap-2 text-sm">
        <span className="text-ops-dim">{question}</span>
        <span className={`font-semibold ${tone}`}>{VERDICT_TEXT[verdict] ?? verdict}</span>
      </p>
      <ul className="mt-1.5 space-y-1 text-[13px] text-ops-text">
        {lines.map((line, i) => (
          <li key={i} className="flex gap-2">
            <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-ops-dim" />
            {line}
          </li>
        ))}
      </ul>
    </div>
  );
}

// A photo taller than 3:2 is narrowed until it is no taller than a 3:2 one of the full width.
const upToLandscape = (width: number, height: number) => (width / height < 1.5 ? { maxWidth: `${((width / height) / 1.5) * 100}%` } : undefined);

// Why a report without a photo was not matched: the rule that stopped it, not only the missing photo.
function noPhotoText(rule: string | undefined): string {
  if (rule === "R0e") return "No photo. Matching was skipped because this may be an emergency.";
  if (rule === "R0s") return "No photo. Reports about people or behavior are never matched by image.";
  if (rule === "R1p") return "No photo. Nothing of this kind is nearby, so there was nothing to match it with.";
  return "No photo. Words and GPS cannot tell this place from a look-alike nearby, so nothing was matched.";
}

function Notice({ children }: { children: React.ReactNode }) {
  return <div className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">{children}</div>;
}

function Confidence({ value }: { value: number }) {
  return (
    <span className="flex items-center gap-2 text-xs text-ops-dim" title="The comparison model's own confidence in the verdict this suggestion rests on. Not a measured accuracy.">
      model confidence
      <span className="relative h-1.5 w-24 overflow-hidden rounded-full bg-ops-raised">
        <span className="absolute inset-y-0 left-0 rounded-full bg-zinc-300" style={{ width: pct(value) }} />
      </span>
      <span className="font-mono text-ops-text">{pct(value)}</span>
    </span>
  );
}

type StepTone = "ok" | "skip" | "warn" | "stop";
const STEP_TONE: Record<StepTone, string> = {
  ok: "border-zinc-500/60 text-white",
  skip: "border-ops-line text-ops-dim",
  warn: "border-amber-500/50 text-amber-300",
  stop: "border-rose-500/50 text-rose-300",
};

// Every stage the report went through, left to right, so staff see where the doubt came from.
function PipelineTrace(props: {
  hasMessage: boolean;
  hasPhoto: boolean; // an emergency skips the photo check: it was there, just not looked at
  intake: IntakeResult | null;
  unread: boolean; // the words went unread (WORDS_NOT_READ)
  triage: TriageResult | undefined;
  candidates: Candidate[];
  photoFound: boolean | undefined;
  comparisons: Comparison[];
  decision: Decision | undefined;
  runs: Run[];
  final: Final | undefined;
  verifiable: boolean;
  verifyLimit: number | null;
}) {
  const { intake, triage, candidates, comparisons, decision, runs, final } = props;
  const top = (stage: 1 | 2) =>
    comparisons.filter((c) => c.stage === stage && !c.fallback).sort((a, b) => b.result!.asset_match.confidence - a.result!.asset_match.confidence)[0]?.result
      ?.asset_match;
  const [full, crop] = [top(1), top(2)];
  const lastRun = runs.at(-1);
  const guard = (lastRun?.guard as GuardResult | null | undefined) ?? null;
  const steps: Array<{ name: string; value: string; tone: StepTone }> = [
    {
      name: "Message",
      value: props.hasMessage ? (intake ? `${intake.category.replace("_", " ")}${intake.emergency ? " · emergency" : ""}` : props.unread ? "not read" : "read") : "none",
      tone: props.hasMessage ? (intake?.emergency ? "stop" : props.unread ? "warn" : "ok") : "skip",
    },
    {
      name: "Triage",
      value: triage ? `${triage.category.replaceAll("_", " ")} · ${triage.image_quality.replaceAll("_", " ")}` : props.hasPhoto ? "skipped" : "no photo",
      tone: triage ? (triage.image_quality === "ok" ? "ok" : "warn") : "skip",
    },
    {
      name: "Search",
      value: decision?.reasons.at(-1)?.rule_id === "R0" ? "not searched" : `${candidates.length} nearby`,
      tone: candidates.length ? "ok" : "skip",
    },
    {
      name: "SAM 3.1",
      // Road damage and dumped piles are boxed by Muse Spark before SAM cuts them out.
      value:
        props.photoFound === undefined
          ? "skipped"
          : triage && (triage.category === "road_damage" || triage.category === "trash")
            ? props.photoFound
              ? "boxed by Spark, cut out"
              : "Spark did not see it"
            : props.photoFound
              ? "object found"
              : "not found",
      tone: props.photoFound === undefined ? "skip" : props.photoFound ? "ok" : "warn",
    },
    {
      name: "Compare",
      value:
        crop || full
          ? [crop && `cut-out ${VERDICT_TEXT[crop.verdict]} ${pct(crop.confidence)}`, full && `photo ${VERDICT_TEXT[full.verdict]} ${pct(full.confidence)}`]
              .filter(Boolean)
              .join(" · ")
          : "skipped",
      tone: !crop && !full ? "skip" : (crop ?? full)!.verdict === "uncertain" ? "warn" : "ok",
    },
    {
      name: "Rules",
      value: decision ? decision.reasons.map((r) => r.rule_id).join(" → ") : "none",
      tone: decision ? (decision.label === "HUMAN_REVIEW" || decision.label === "NEEDS_INFO" ? "warn" : "ok") : "skip",
    },
    {
      name: "Verify",
      value: lastRun ? (RUN_TEXT[lastRun.status] ?? lastRun.status) : props.verifiable ? "not run, staff can ask" : props.verifyLimit !== null ? `limit reached (${props.verifyLimit} runs)` : "not needed",
      tone: lastRun ? (lastRun.status === "proposed" ? "ok" : "warn") : "skip",
    },
    {
      name: "Guardrail",
      value: guard ? (guard.passed ? "passed" : `blocked ${guard.blocked_rules.join(",")}`) : "not run",
      tone: guard ? (guard.passed ? "ok" : "stop") : "skip",
    },
  ];
  // Collapsed: staff read the suggestion and the photos first; the stages are for whoever checks the run.
  return (
    <details className="group rounded-lg border border-ops-line bg-ops-panel">
      <summary className="flex cursor-pointer select-none list-none items-center gap-3 px-4 py-2.5 text-[13px] [&::-webkit-details-marker]:hidden">
        <svg viewBox="0 0 12 12" aria-hidden className="h-3 w-3 text-ops-dim transition group-open:rotate-90">
          <path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="font-medium text-ops-text">How the pipeline got here</span>
        <span className="text-xs text-ops-dim">message, photo check, search, cut-outs, comparison, rules, verification</span>
      </summary>
      <ol className="flex flex-wrap items-stretch border-t border-ops-line p-1">
        {steps.map((s, i) => (
          <li key={s.name} className="flex items-center">
            <div className={`m-2 min-w-[118px] rounded-md border-l-2 bg-ops-raised px-3 py-2 ${STEP_TONE[s.tone]}`}>
              <div className="text-[10px] uppercase tracking-[0.12em] text-ops-dim">{s.name}</div>
              <div className="mt-0.5 font-mono text-[11px]">{s.value}</div>
            </div>
            {i < steps.length - 1 && <span className="text-ops-line">›</span>}
          </li>
        ))}
        {final && (
          <li className="flex items-center">
            <span className="text-ops-line">›</span>
            <div className="m-2">
              <OpsLabel label={final.label} />
            </div>
          </li>
        )}
      </ol>
    </details>
  );
}

// Observation, arrival and repair on one axis: a late report and a recurrence differ only in where the dots fall.
function TimeBar({ observed, submitted, created, resolved, fix }: { observed: string; submitted: string; created: string | null; resolved: string | null; fix: Fix }) {
  // Seen and sent within the same minute: one mark, not two labels with the same time.
  const together = Math.abs(Date.parse(observed) - Date.parse(submitted)) < 60_000;
  const marks = [
    { t: created, text: "Incident opened", color: "bg-zinc-400" },
    { t: resolved, text: fix === "cleanup" ? "Cleanup recorded" : "Repair recorded", color: "bg-emerald-400" },
    ...(together
      ? [{ t: submitted, text: "Seen and reported", color: "bg-white" }]
      : [
          { t: observed, text: "Resident saw it", color: "bg-white" },
          { t: submitted, text: "Report arrived", color: "bg-white" },
        ]),
  ].filter((m): m is { t: string; text: string; color: string } => Boolean(m.t));
  const times = marks.map((m) => new Date(m.t).getTime());
  const [min, max] = [Math.min(...times), Math.max(...times)];
  const pos = (t: string) => (max === min ? 50 : ((new Date(t).getTime() - min) / (max - min)) * 100);
  // The stretch between the repair and the resident's sighting is the whole question: before it, a late
  // report; after it, the problem may be back.
  const gap = resolved
    ? (() => {
        const after = Date.parse(observed) > Date.parse(resolved);
        const [from, to] = after ? [resolved, observed] : [observed, resolved];
        return { left: pos(from), width: pos(to) - pos(from), after, text: `${span(Date.parse(to) - Date.parse(from))} ${after ? "after" : "before"} the ${fix}` };
      })()
    : null;
  return (
    <Panel title="Timeline">
      <div className="relative mx-3 mb-20 mt-10 h-px bg-ops-line">
        {gap && (
          <>
            <div className={`absolute -top-px h-[3px] rounded-full ${gap.after ? "bg-rose-400" : "bg-sky-400"}`} style={{ left: `${gap.left}%`, width: `${gap.width}%` }} />
            {/* Centered over the gap, but held to the gap's own end when that is near an edge of the bar: on a phone a
                centered label at the end would run off the screen. */}
            <div
              className={`absolute -top-8 whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium ${gap.left + gap.width / 2 > 70 || gap.left + gap.width / 2 < 30 ? "" : "-translate-x-1/2"} ${gap.after ? "bg-rose-500/15 text-rose-200" : "bg-sky-500/15 text-sky-200"}`}
              style={
                gap.left + gap.width / 2 > 70
                  ? { right: `${100 - gap.left - gap.width}%` }
                  : gap.left + gap.width / 2 < 30
                    ? { left: `${gap.left}%` }
                    : { left: `${gap.left + gap.width / 2}%` }
              }
            >
              Seen {gap.text}
            </div>
          </>
        )}
        {marks.map((m, i) => (
          <div key={m.text} className="absolute -top-1.5" style={{ left: `${pos(m.t)}%` }}>
            <div className={`h-3 w-3 -translate-x-1/2 rounded-full ring-4 ring-ops-panel ${m.color}`} />
            {/* Labels alternate between two rows so close marks do not overlap, and hug the ends of the bar. */}
            <div
              className={`absolute w-32 text-xs leading-tight ${pos(m.t) > 85 ? "right-0 text-right" : pos(m.t) < 15 ? "left-0 text-left" : "-translate-x-1/2 text-center"}`}
              style={{ top: i % 2 ? 52 : 16 }}
            >
              <span className="text-ops-text">{m.text}</span>
              <br />
              <span className="text-ops-dim tabular-nums">{when(m.t)}</span>
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

// The agent proposed what the rules' recheck also answered (the run's trigger label for the same incident).
function sameAsGuardFallback(run: Run): boolean {
  const p = run.proposal as { label?: string; incident_id?: string | null } | null | undefined;
  const t = run.trigger as { label?: string } | null;
  return Boolean(p?.label && t?.label && p.label === t.label);
}

function span(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)} days`;
}

// The incident ids in a step's summary, by name where the page knows it.
// An id the page has no name for (an incident opened after the analysis, say) still reads as words.
const byName = (text: string, labels: Record<string, string>) =>
  Object.entries(labels)
    .reduce((t, [id, label]) => t.replaceAll(id, label), text)
    .replace(/\binc_[a-z0-9]+\b/g, "another incident");

function Investigation({ runs, currentRunId, names }: { runs: Run[]; currentRunId: number | null; names: Record<string, string> }) {
  return (
    <Panel title="Verification agent" aside="Muse Spark · tool calls">
      {runs.map((run) => {
        const steps = run.steps as StepView[];
        const guard = run.guard as GuardResult | null;
        return (
          <div key={run.id} className="space-y-2">
            <p className="text-[11px] text-ops-dim">
              {run.requested_by === "staff" ? "Requested by staff" : "Ran automatically on the suggestion"}
              {run.applied && run.id !== currentRunId && <span className="ml-2">· ran on an earlier analysis of this report</span>}
              {!run.applied && <span className="ml-2 text-amber-300">Not applied: the report changed while it ran</span>}
              {run.applied && (run.status === "failed" || run.status === "budget_exceeded") && (
                <span className="ml-2 text-amber-300">Stopped partway; the rules still read every tool result above</span>
              )}
            </p>
            <ol className="space-y-1.5 text-[12px]">
              {steps.map((s) => (
                <li key={s.ref} className="flex gap-2.5">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ops-raised font-mono text-[10px] text-ops-dim">
                    {s.step}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-baseline gap-x-2">
                      <span className="font-medium text-white">{TOOL_TEXT[s.tool] ?? s.tool}</span>
                      <span className="font-mono text-[10px] text-ops-dim">{s.tool}</span>
                    </span>
                    <span className={`block break-words ${s.ok ? "text-ops-text" : "text-rose-300"}`}>{byName(summarize(s), names)}</span>
                  </span>
                </li>
              ))}
            </ol>
            <p className="flex flex-wrap items-center gap-2 border-t border-ops-line pt-2 text-[11px]">
              {guard ? (
                guard.passed ? (
                  <span className="rounded bg-emerald-500/15 px-2 py-0.5 text-emerald-300">Guardrail passed</span>
                ) : (
                  // A blocked proposal is left out of the answer: the fast path's and the rules' recheck stand. When it
                  // proposed that same answer, only its citations fell short.
                  <span className="rounded bg-rose-500/15 px-2 py-0.5 text-rose-300">
                    <span title={`Guardrail rules: ${guard.blocked_rules.join(", ")}`}>
                      {sameAsGuardFallback(run)
                        ? "The guardrail did not count the agent's proposal, which cited no confident comparison; the rules gave the same answer"
                        : "The guardrail left out the agent's proposal, which cited no confident comparison; the rules' answer stands"}
                    </span>
                  </span>
                )
              ) : (
                <span className="text-ops-dim">Run ended: {run.status.replace("_", " ")}</span>
              )}
              <span className="ml-auto font-mono text-ops-dim">
                {cost(run.cost_usd)} · {(run.latency_ms / 1000).toFixed(1)}s
              </span>
            </p>
          </div>
        );
      })}
    </Panel>
  );
}

// Staff words for the image ids that stored texts carry: internal ids mean nothing to staff, and a dataset id
// names the photo's state, which is the answer the comparison is there to find.
function photoNames(reportPhotos: string[], comparisons: Comparison[], titles: Record<string, string>): Record<string, string> {
  const names: Record<string, string> = {};
  reportPhotos.forEach((id, i) => {
    names[id] = i === 0 ? "the report's photo" : reportPhotos.length > 2 ? `the resident's answer photo ${i}` : "the resident's answer photo";
  });
  const byIncident = new Map<string, string[]>();
  for (const c of comparisons) {
    if (c.candidate_image_id in names) continue;
    const ids = byIncident.get(c.incident_id) ?? [];
    if (!ids.includes(c.candidate_image_id)) ids.push(c.candidate_image_id);
    byIncident.set(c.incident_id, ids);
  }
  for (const [incident, ids] of byIncident) {
    const owner = titles[incident] ? `the ${titles[incident]}` : "the incident";
    ids.forEach((id, i) => (names[id] = ids.length > 1 ? `photo ${i + 1} of ${owner}` : `the photo of ${owner}`));
  }
  return names;
}

// The comparison model calls the two photos NEW and CANDIDATE; staff know them as this report and the incident.
// The comparison model names the images it was shown (NEW and CANDIDATE, IMAGE N1/N2 and C1/C2); staff read photos.
const photoWords = (text: string, incidentId: string) =>
  text
    .replace(/\b(?:IMAGE\s+)?N\d(?:\s*(?:\/|and|&)\s*N\d)*\b/g, "this photo")
    .replace(/\b(?:IMAGE\s+)?C\d(?:\s*(?:\/|and|&)\s*C\d)*\b/g, "the incident's photo")
    .replace(/\bNEW\b/g, "this photo")
    .replace(/^new (?=shows|has|is)/i, "this photo ")
    .replace(/\bcandidate\b/gi, "the incident's photo")
    .replaceAll(incidentId, "the incident");

const RUN_TEXT: Record<string, string> = {
  proposed: "finished",
  blocked: "finished, proposal blocked",
  asked_resident: "finished",
  failed: "stopped partway",
  budget_exceeded: "hit its limit",
};

const VERDICT_TONE: Record<Verdict["kind"], { box: string; dot: string; title: string }> = {
  confirmed: { box: "border-emerald-500/40 bg-emerald-500/10", dot: "bg-emerald-400", title: "text-emerald-200" },
  unchanged: { box: "border-ops-line bg-ops-panel", dot: "bg-zinc-400", title: "text-zinc-100" },
  blocked: { box: "border-amber-500/40 bg-amber-500/10", dot: "bg-amber-400", title: "text-amber-100" },
  against: { box: "border-orange-500/50 bg-orange-500/10", dot: "bg-orange-400", title: "text-orange-200" },
  unsettled: { box: "border-ops-line bg-ops-panel", dot: "bg-zinc-400", title: "text-zinc-100" },
};

// The verification's answer in one line under the decision; the comparisons behind it are in the card beside the evidence.
function VerdictLine({ verdict }: { verdict: Verdict }) {
  const tone = VERDICT_TONE[verdict.kind];
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className={`h-2 w-2 shrink-0 rounded-full ${tone.dot}`} />
      <span className={`font-medium ${tone.title}`}>{verdict.title}</span>
      {verdict.kind === "confirmed" && verdict.detail && <span className="text-ops-dim">{verdict.detail}</span>}
      <a href="#verification" className="text-xs text-ops-dim underline decoration-ops-line underline-offset-2 hover:text-white">
        Details
      </a>
    </p>
  );
}

// The incident photo a verification comparison looked at, so a ruled-out look-alike is seen, not only named.
function ComparedPhoto({ id }: { id?: string }) {
  if (!id) return null;
  return (
    <a href={`/api/images/${id}`} target="_blank" rel="noreferrer" className="shrink-0">
      {/* eslint-disable-next-line @next/next/no-img-element -- resized by our image route */}
      <img src={`/api/images/${id}?w=160`} alt="The incident photo it was compared with" className="h-10 w-14 rounded border border-ops-line object-cover" />
    </a>
  );
}

// What the verification found: the answer first, then the comparisons behind it.
function VerdictCard({ verdict }: { verdict: Verdict }) {
  const tone = VERDICT_TONE[verdict.kind];
  return (
    <section id="verification" className={`scroll-mt-72 rounded-lg border px-4 py-3 ${tone.box}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={`h-2 w-2 shrink-0 rounded-full ${tone.dot}`} />
        <p className={`font-semibold ${tone.title}`}>{verdict.title}</p>
      </div>
      <p className="mt-0.5 text-xs text-ops-dim">Verification agent, requested by staff</p>
      {verdict.detail && <p className="mt-2 text-sm text-ops-text">{verdict.detail}</p>}
      {(verdict.against.length > 0 || verdict.agree.length > 0) && (
        <ul className="mt-2 space-y-1 text-[13px]">
          {verdict.against.map((line) => (
            <li key={line} className="flex items-center gap-2 text-orange-200">
              <span className="w-3 shrink-0 text-center">✕</span>
              <ComparedPhoto id={verdict.photos[line]} />
              {line}
            </li>
          ))}
          {verdict.agree.map((line) => {
            // A look-alike ruled out is a check that came out as expected, not a match: a neutral mark.
            const ruledOutLine = line.endsWith("(ruled out)");
            return (
              <li key={line} className="flex items-center gap-2 text-ops-text">
                <span className={`w-3 shrink-0 text-center ${ruledOutLine ? "text-ops-dim" : "text-emerald-300"}`}>{ruledOutLine ? "○" : "✓"}</span>
                <ComparedPhoto id={verdict.photos[line]} />
                {line}
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-2 text-[11px] text-ops-dim">
        {verdict.kind === "confirmed"
          ? "The checks back the suggestion. The suggested decision above applies it."
          : "Decide from the evidence beside this. The full run is under Verification agent."}
      </p>
    </section>
  );
}

function changeText(c: FactChange, names: Record<string, string>): string {
  const open = (status: string) => status === "open" || status === "in_progress";
  // Staff read incidents by name ("the round pothole by the curb"), as everywhere else on the page.
  const name = names[c.incident_id] ?? "The incident";
  const Name = name.charAt(0).toUpperCase() + name.slice(1);
  if (open(c.was.status) && !open(c.now.status)) return `${Name} was marked fixed ${when(c.now.resolved_at)}, after this suggestion was made.`;
  if (!open(c.was.status) && open(c.now.status)) return `${Name} was reopened after this suggestion was made.`;
  return `The repair time of ${name === "The incident" ? "the incident" : name} changed to ${when(c.now.resolved_at)} after this suggestion was made.`;
}

// A suggestion made before an incident changed reads old facts; the fast path on the current ones replaces it.
function OutOfDate({ changes, reportId, analysisId, names }: { changes: FactChange[]; reportId: string; analysisId: number; names: Record<string, string> }) {
  return (
    <section className="mt-2 flex flex-col gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-semibold text-amber-100">This suggestion is out of date</p>
        {changes.map((c) => (
          <p key={c.incident_id} className="mt-0.5 text-amber-100/85">
            {changeText(c, names)}
          </p>
        ))}
        <p className="mt-0.5 text-[12px] text-amber-100/70">
          Whether this is a late report or a problem back after the repair depends on that. Analyze it again on the current facts before verifying or deciding.
        </p>
      </div>
      <ReanalyzeButton reportId={reportId} analysisId={analysisId} />
    </section>
  );
}
