// Author: HyeonMo Gu
// Created: 2026-10-27

import Link from "next/link";
import { notFound } from "next/navigation";
import type { Candidate, Comparison, Decision } from "@/lib/pipeline/decide";
import type { GuardResult } from "@/lib/pipeline/guard";
import type { IntakeResult } from "@/lib/pipeline/intake";
import type { TriageResult } from "@/lib/pipeline/triage";
import { AGENT_LIMITS } from "@/lib/pipeline/config";
import { VERIFIED } from "@/lib/pipeline/hybrid";
import { ANALYSIS_LEASE_MS, changedFacts, reportDetail, staleAnalysis, type FactChange } from "@/lib/server/reports";
import { runtime } from "@/lib/server/runtime";
import type { Box, Channel, Label, RequestItem } from "@/lib/tools/types";
import { Fact, OpsLabel, Panel, UrgentTag, LABEL_TONE, pct, readable, VERDICT_TEXT } from "@/app/_ui/console";
import { when } from "@/app/_ui/format";
import { LABEL_TEXT } from "@/app/_ui/labels";
import { MaskedPhoto } from "@/app/_ui/photo";
import { Actions, RetryButton } from "./actions";
import { summarize, TOOL_TEXT, verdictOf, type StepView, type Verdict } from "./steps";
import { ReanalyzeButton, VerifyProgress, VerifyProvider } from "./verify";

export const dynamic = "force-dynamic";

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

// The suggestion in one sentence, as staff would say it.
// Suggestions that tie the report to an incident; HUMAN_REVIEW may name one without tying the report to it.
const LINKS: ReadonlySet<Label> = new Set(["DUPLICATE", "LATE_REPORT", "ALREADY_RESOLVED", "POSSIBLE_RECURRENCE"]);

function headline(label: Label, incident: string | null): string {
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
      return `Back after the repair of ${incident}?`;
    case "NEEDS_INFO":
      return "Waiting for one more thing from the resident";
    case "HUMAN_REVIEW":
      return "Needs a person to decide";
  }
}

export default async function ReportDetail({ params }: { params: Promise<{ id: string }> }) {
  const detail = await reportDetail(await runtime(), (await params).id);
  if (!detail) notFound();
  const { report, analysis, runs, questions, photos, incidents, incidentPhotos, imageFacts, segmentations } = detail;
  const triage = (analysis?.triage as TriageResult | null | undefined) ?? undefined;
  const intake = (analysis?.intake as IntakeResult | null | undefined) ?? null;
  const decision = analysis?.decision as Decision | undefined;
  const final = analysis?.final as Final | undefined;
  const candidates = (analysis?.candidates as Candidate[] | undefined) ?? [];
  const comparisons = (analysis?.comparisons as Comparison[] | undefined) ?? [];

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
  // Staff can ask the agent to check a closing suggestion that is waiting for them.
  const verifiable =
    waiting && changes.length === 0 && final !== undefined && VERIFIED.has(final.label) && analysis!.input !== null && runs.length < AGENT_LIMITS.max_runs_per_report;
  const verifyLimit =
    waiting && changes.length === 0 && final !== undefined && VERIFIED.has(final.label) && analysis!.input !== null && runs.length >= AGENT_LIMITS.max_runs_per_report
      ? AGENT_LIMITS.max_runs_per_report
      : null;
  const verifying = report.verify_claimed_at !== null && Date.parse(String(report.verify_claimed_at)) > Date.now() - ANALYSIS_LEASE_MS;
  // The latest run's verdict, while its result is the suggestion on screen (no analysis since).
  const lastRun = (runs as Run[]).at(-1);
  const currentRunId = lastRun && analysis?.pipeline_config === "C_rules+verify" ? lastRun.id : null;
  const verdict: Verdict | null =
    lastRun && lastRun.applied && lastRun.requested_by === "staff" && analysis?.pipeline_config === "C_rules+verify" && final && decision
      ? verdictOf({
          status: lastRun.status,
          guard: lastRun.guard as GuardResult | null,
          steps: lastRun.steps as StepView[],
          before: { label: (lastRun.trigger as { label: Label }).label, incident_id: decision.incident_id },
          after: final,
        })
      : null;
  // Compared and judged a different place or fixture: shown as a checked-and-excluded note, not as a match.
  const ruledOut = !linked && shownMatch?.result?.asset_match.verdict === "different";
  const focusDistance = candidates.find((c) => c.incident_id === focusId)?.distance_m;

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
        <span className="font-mono text-[11px] uppercase tracking-wider text-ops-dim">{report.status.replace("_", " ")}</span>
        {analysis && (
          <span className="ml-auto font-mono text-[11px] text-ops-dim">
            ${analysis.cost_usd.toFixed(3)} · {(analysis.latency_ms / 1000).toFixed(1)}s · {report.is_synthetic ? "synthetic sample" : "resident upload"}
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
              Act on it now. The resident was told to call the emergency number; matching to existing incidents was skipped.
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
                {report.incident_id}
              </Link>{" "}
              from this report before the demo begins. It is part of the starting history that new reports are compared with, so it never went through the
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
        <VerifyProvider reportId={report.id}>
          {/* Verdict and decision: one band that stays under the header while staff look through the evidence. */}
          <div className="z-[999] -mx-4 mt-4 bg-ops-bg/95 px-4 py-2 backdrop-blur md:sticky md:top-[45px]">
            <section
              className={`flex flex-col gap-3 rounded-lg border border-ops-line bg-ops-panel px-4 py-3 ring-1 ring-inset xl:flex-row xl:items-center xl:gap-6 ${final ? LABEL_TONE[final.label].ring : ""}`}
            >
              {final && (
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <OpsLabel label={final.label} />
                    <p className="text-lg font-semibold tracking-tight text-white">{headline(final.label, final.incident_id)}</p>
                    {final.incident_id && (
                      <Link
                        href={`/admin/incidents/${final.incident_id}`}
                        className="font-mono text-xs text-white underline decoration-ops-dim underline-offset-2 hover:decoration-white"
                      >
                        {final.incident_id} →
                      </Link>
                    )}
                  </div>
                  <div className="mt-1 flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-4">
                    {lastReason && (
                      <p className="min-w-0 flex-1 text-sm text-ops-dim md:truncate" title={readable(lastReason)}>
                        {readable(lastReason)}
                      </p>
                    )}
                    {/* The confidence is the fast path's; once verification changed the answer it is not this answer's. */}
                    {decision && !answerChanged && <Confidence value={decision.confidence} />}
                  </div>
                  {decision && answerChanged && (
                    <p className="mt-1 text-xs text-ops-dim">
                      Before verification: {LABEL_TEXT[decision.label]} (fast path, {pct(decision.confidence)} confidence)
                      <span className="ml-2 font-mono text-[10px]">
                        {decision.rule_id} → {final.rule_id}
                      </span>
                    </p>
                  )}
                </div>
              )}
              <Actions
                reportId={report.id}
                analysisId={analysis.id}
                final={final ?? null}
                focusId={focusId}
                askFor={photos.length === 0 ? "photo" : "wider_context"}
                decided={decided}
                stale={changes.length > 0}
                verify={verifiable ? { analysisId: analysis!.id, running: verifying, again: runs.length > 0 } : null}
                verifyLimit={verifyLimit}
              />
            </section>
            <VerifyProgress maxSteps={AGENT_LIMITS.max_steps} maxMs={AGENT_LIMITS.max_ms} runningSince={verifying ? String(report.verify_claimed_at) : null} />
          </div>
          {changes.length > 0 && <OutOfDate changes={changes} reportId={report.id} analysisId={analysis.id} />}
          {verdict && !decided && changes.length === 0 && <VerdictCard verdict={verdict} />}

          <div className="mt-2 grid gap-4 xl:grid-cols-[1fr_380px]">
            <div className="min-w-0 space-y-4">
              {/* Evidence */}
              <div className={`grid gap-4 ${ruledOut ? "lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]" : "lg:grid-cols-2"}`}>
                <Panel title="New report" aside={`seen ${when(report.observed_at)}`}>
                  {photos.length === 0 ? (
                    <div className="flex aspect-[3/2] items-center justify-center rounded-md border border-dashed border-ops-line p-6 text-center text-sm text-ops-dim">
                      No photo. Words and GPS cannot tell this place from a look-alike nearby, so nothing was matched.
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
                    title={`Ruled out: incident ${focus.id}`}
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
                      <details className="group mt-4">
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
                            caption={`${focus.id}, not this report`}
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
                          ? `Linked incident ${focus.id}`
                          : compared
                            ? `Compared with incident ${focus.id}`
                            : `Nearest incident ${focus.id}`
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
                      <div className="flex aspect-[3/2] items-center justify-center rounded-md border border-dashed border-ops-line text-sm text-ops-dim">
                        Nothing of this kind within the search radius.
                      </div>
                    )}
                  </Panel>
                )}
              </div>

              <PipelineTrace
                hasMessage={Boolean(report.description || report.audio_path)}
                intake={intake}
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
              />

              {candidates.length > 0 && (
                <Panel title="Nearby incidents checked" aside={`${candidates.length} within the search radius`}>
                  <table className="w-full text-[13px]">
                    <thead className="text-left text-[11px] uppercase tracking-wider text-ops-dim">
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
                            <span className="text-sky-300">linked</span>
                          ) : final?.incident_id === c.incident_id ? (
                            <span className="text-amber-300">staff decides</span>
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
                                {c.incident_id}
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
                </Panel>
              )}
            </div>

            {/* Reasons column */}
            <aside className="space-y-4">
              <Panel title="Why">
                {/* The rules read in order; the last one decided. Rule ids stay for whoever checks the decision table. */}
                <ol className="space-y-2 text-[13px]">
                  {decision?.reasons.map((r, i, all) => {
                    const last = i === all.length - 1;
                    return (
                      <li key={i} className={`flex gap-2.5 ${last ? "rounded-md bg-ops-raised px-2.5 py-2" : "px-2.5"}`}>
                        <span className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${last ? "bg-white" : "bg-ops-dim"}`} />
                        <span className="min-w-0 flex-1">
                          {last && <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-[0.12em] text-ops-dim">Result</span>}
                          <span className={last ? "font-medium text-white" : "text-ops-text"}>{readable(r.text)}</span>
                        </span>
                        <span className="shrink-0 pt-px font-mono text-[10px] text-ops-dim" title={`Rule ${r.rule_id}`}>
                          {r.rule_id}
                        </span>
                      </li>
                    );
                  })}
                </ol>
                {best?.result && (
                  <>
                    <h3 className="mt-4 text-[11px] font-semibold uppercase tracking-[0.12em] text-ops-dim">What the photos show</h3>
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

              {(report.description || report.audio_path || intake) && (
                <Panel title="Resident's message">
                  {report.description && <p className="text-sm">“{report.description}”</p>}
                  {report.audio_path && (
                    <div className="mt-2 space-y-2">
                      <audio controls src={`/api/reports/${report.id}/audio`} className="h-9 w-full" />
                      <p className="text-[13px] text-ops-dim">
                        <span className="text-[11px] uppercase tracking-wider">Muse Voice Transcribe</span>
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
                      <span className={`font-mono text-[10px] uppercase ${q.status === "pending" ? "text-violet-300" : "text-ops-dim"}`}>
                        {q.reason_for_staff === "Requested by staff"
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

              {runs.length > 0 && <Investigation runs={runs as Run[]} currentRunId={currentRunId} />}
            </aside>
          </div>
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
      title={`Muse Spark compared ${crops ? "the SAM cut-outs" : "the whole photos"}: "${VERDICT_TEXT[verdict] ?? verdict}", ${pct(confidence)} confidence. Not a similarity score.`}
    >
      {crops ? "cut-out" : "whole photo"}: {VERDICT_TEXT[verdict] ?? verdict} · {pct(confidence)}
      {verdict === "uncertain" ? "" : " sure"}
    </span>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return <div className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">{children}</div>;
}

function Confidence({ value }: { value: number }) {
  return (
    <span className="ml-auto flex items-center gap-2 text-[11px] text-ops-dim">
      confidence
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
  intake: IntakeResult | null;
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
      value: props.hasMessage ? (intake ? `${intake.category.replace("_", " ")}${intake.emergency ? " · emergency" : ""}` : "read") : "none",
      tone: props.hasMessage ? (intake?.emergency ? "stop" : "ok") : "skip",
    },
    {
      name: "Triage",
      value: triage ? `${triage.category.replace("_", " ")} · ${triage.image_quality.replace("_", " ")}` : "no photo",
      tone: triage ? (triage.image_quality === "ok" ? "ok" : "warn") : "skip",
    },
    {
      name: "Search",
      value: `${candidates.length} nearby`,
      tone: candidates.length ? "ok" : "skip",
    },
    {
      name: "SAM 3.1",
      value: props.photoFound === undefined ? "skipped" : props.photoFound ? "object found" : "not found",
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
  return (
    <div className="rounded-lg border border-ops-line bg-ops-panel p-1">
      <ol className="flex flex-wrap items-stretch">
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
    </div>
  );
}

// Observation, arrival and repair on one axis: a late report and a recurrence differ only in where the dots fall.
function TimeBar({ observed, submitted, created, resolved }: { observed: string; submitted: string; created: string | null; resolved: string | null }) {
  const marks = [
    { t: created, text: "Incident opened", color: "bg-zinc-400" },
    { t: resolved, text: "Repair recorded", color: "bg-emerald-400" },
    { t: observed, text: "Resident saw it", color: "bg-white" },
    { t: submitted, text: "Report arrived", color: "bg-white" },
  ].filter((m): m is { t: string; text: string; color: string } => Boolean(m.t));
  const times = marks.map((m) => new Date(m.t).getTime());
  const [min, max] = [Math.min(...times), Math.max(...times)];
  const pos = (t: string) => (max === min ? 50 : ((new Date(t).getTime() - min) / (max - min)) * 100);
  return (
    <Panel title="Timeline">
      <div className="relative mx-3 mb-20 mt-3 h-px bg-ops-line">
        {marks.map((m, i) => (
          <div key={m.text} className="absolute -top-1.5" style={{ left: `${pos(m.t)}%` }}>
            <div className={`h-3 w-3 -translate-x-1/2 rounded-full ring-4 ring-ops-panel ${m.color}`} />
            {/* Labels alternate between two rows so close marks do not overlap, and hug the ends of the bar. */}
            <div
              className={`absolute w-32 text-[11px] leading-tight ${pos(m.t) > 85 ? "right-0 text-right" : pos(m.t) < 15 ? "left-0 text-left" : "-translate-x-1/2 text-center"}`}
              style={{ top: i % 2 ? 52 : 16 }}
            >
              <span className="text-ops-text">{m.text}</span>
              <br />
              <span className="font-mono text-ops-dim">{when(m.t)}</span>
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function Investigation({ runs, currentRunId }: { runs: Run[]; currentRunId: number | null }) {
  return (
    <Panel title="Verification agent" aside="Muse Spark · tool calls">
      {runs.map((run) => {
        const steps = run.steps as StepView[];
        const guard = run.guard as GuardResult | null;
        return (
          <div key={run.id} className="space-y-2">
            <p className="text-[11px] text-ops-dim">
              {run.requested_by === "staff" ? "Requested by staff" : "Ran automatically on the suggestion"}
              {run.applied && run.id !== currentRunId && <span className="ml-2">· on an earlier analysis, replaced since</span>}
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
                    <span className={`block break-words ${s.ok ? "text-ops-text" : "text-rose-300"}`}>{summarize(s)}</span>
                  </span>
                </li>
              ))}
            </ol>
            <p className="flex flex-wrap items-center gap-2 border-t border-ops-line pt-2 text-[11px]">
              {guard ? (
                guard.passed ? (
                  <span className="rounded bg-emerald-500/15 px-2 py-0.5 text-emerald-300">Guardrail passed</span>
                ) : (
                  <span className="rounded bg-rose-500/15 px-2 py-0.5 text-rose-300">
                    Guardrail blocked ({guard.blocked_rules.join(", ")}) → {LABEL_TEXT[guard.final_label]}
                  </span>
                )
              ) : (
                <span className="text-ops-dim">Run ended: {run.status.replace("_", " ")}</span>
              )}
              <span className="ml-auto font-mono text-ops-dim">
                ${run.cost_usd.toFixed(3)} · {(run.latency_ms / 1000).toFixed(1)}s
              </span>
            </p>
          </div>
        );
      })}
    </Panel>
  );
}

// The comparison model calls the two photos NEW and CANDIDATE; staff know them as this report and the incident.
const photoWords = (text: string, incidentId: string) => text.replace(/\bNEW\b/g, "this photo").replace(/\bCANDIDATE\b/g, incidentId);

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

// What the verification found, in one card: the answer first, then the comparisons behind it.
function VerdictCard({ verdict }: { verdict: Verdict }) {
  const tone = VERDICT_TONE[verdict.kind];
  return (
    <section className={`mt-2 rounded-lg border px-4 py-3 ${tone.box}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className={`h-2 w-2 shrink-0 rounded-full ${tone.dot}`} />
        <p className={`font-semibold ${tone.title}`}>{verdict.title}</p>
        <span className="text-[11px] text-ops-dim">Verification agent, requested by staff</span>
      </div>
      {verdict.detail && <p className="mt-1 text-sm text-ops-text">{verdict.detail}</p>}
      {(verdict.against.length > 0 || verdict.agree.length > 0) && (
        <ul className="mt-2 grid gap-x-6 gap-y-1 text-[12px] sm:grid-cols-2">
          {verdict.against.map((line) => (
            <li key={line} className="flex gap-2 text-orange-200">
              <span className="w-3 shrink-0 text-center">✕</span>
              {line}
            </li>
          ))}
          {verdict.agree.map((line) => (
            <li key={line} className="flex gap-2 text-ops-text">
              <span className="w-3 shrink-0 text-center text-emerald-300">✓</span>
              {line}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-[11px] text-ops-dim">
        {verdict.kind === "confirmed"
          ? "The checks back the suggestion. The white button above applies it."
          : "Decide from the evidence below. The full run is under Verification agent."}
      </p>
    </section>
  );
}

function changeText(c: FactChange): string {
  const open = (status: string) => status === "open" || status === "in_progress";
  if (open(c.was.status) && !open(c.now.status)) return `${c.incident_id} was marked fixed ${when(c.now.resolved_at)}, after this suggestion was made.`;
  if (!open(c.was.status) && open(c.now.status)) return `${c.incident_id} was reopened after this suggestion was made.`;
  return `The repair time of ${c.incident_id} changed to ${when(c.now.resolved_at)} after this suggestion was made.`;
}

// A suggestion made before an incident changed reads old facts; the fast path on the current ones replaces it.
function OutOfDate({ changes, reportId, analysisId }: { changes: FactChange[]; reportId: string; analysisId: number }) {
  return (
    <section className="mt-2 flex flex-col gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-semibold text-amber-100">This suggestion is out of date</p>
        {changes.map((c) => (
          <p key={c.incident_id} className="mt-0.5 text-amber-100/85">
            {changeText(c)}
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
