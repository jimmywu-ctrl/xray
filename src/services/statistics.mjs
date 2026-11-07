import { now, baselineDecision, peakDecision } from "../domain/rules.mjs";
export class StatisticsService {
  constructor(repo, changed = () => {}) {
    this.repo = repo;
    this.changed = changed;
  }
  write(chain, address, version, kind, point, guard = () => true) {
    return this.repo.transaction(() => {
      if (!guard() || !this.repo.current(chain, address, version)) return false;
      const c = this.repo.claim(chain, address),
        r = this.repo.get(
          "SELECT * FROM results WHERE chain=? AND address=?",
          chain,
          address,
        ),
        base = this.repo.evidence(r.baseline_id);
      const witnesses = this.repo
        .all(
          "SELECT payload FROM evidence WHERE chain=? AND address=? AND claim_version=? AND accepted=1 AND revoked=0 AND kind='peak'",
          chain,
          address,
          version,
        )
        .map((e) => JSON.parse(e.payload));
      const decision =
        kind === "baseline"
          ? baselineDecision(point, c.at)
          : peakDecision(point, base, c.at, witnesses);
      if (decision.accepted && kind !== "baseline") {
        const existing = this.repo.evidence(
          kind === "low"
            ? r.low_id
            : decision.formal
              ? r.formal_peak_id
              : r.reference_peak_id,
        );
        const low = this.repo.evidence(r.low_id),
          reference = this.repo.evidence(r.reference_peak_id);
        const neededWitness =
          kind === "peak" &&
          base &&
          point.provider === base.provider &&
          reference &&
          Math.abs(reference.at - point.at) <= 60 &&
          Math.abs(reference.mc / point.mc - 1) <= 0.01;
        if (
          existing &&
          (kind === "low"
            ? point.mc >= existing.mc
            : point.mc <= existing.mc) &&
          (!low || point.mc >= low.mc) &&
          !neededWitness
        )
          return true;
      }
      const revoked = this.repo.get(
        "SELECT id FROM evidence WHERE chain=? AND address=? AND claim_version=? AND kind=? AND provider=? AND at=? AND mc IS ? AND price IS ? AND revoked=1",
        chain,
        address,
        version,
        kind,
        point.provider,
        point.at,
        point.mc ?? null,
        point.price ?? null,
      );
      if (revoked) return false;
      if (
        !decision.accepted &&
        this.repo.get(
          "SELECT 1 FROM evidence WHERE chain=? AND address=? AND claim_version=? AND provider=? AND reason=? AND received_at>?",
          chain,
          address,
          version,
          point.provider,
          decision.reason,
          now() - 300,
        )
      )
        return false;
      const payload = { ...point, ...decision };
      this.repo.run(
        "INSERT OR IGNORE INTO evidence(chain,address,claim_version,kind,provider,at,mc,price,payload,accepted,reason,received_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        chain,
        address,
        version,
        kind,
        point.provider,
        point.at,
        point.mc,
        point.price,
        JSON.stringify(payload),
        decision.accepted ? 1 : 0,
        decision.reason,
        now(),
      );
      if (decision.accepted) this.recompute(chain, address, version);
      return decision.accepted;
    });
  }
  recompute(chain, address, version) {
    if (!this.repo.current(chain, address, version)) return;
    const c = this.repo.claim(chain, address),
      points = this.repo
        .all(
          "SELECT * FROM evidence WHERE chain=? AND address=? AND claim_version=? AND revoked=0",
          chain,
          address,
          version,
        )
        .map((e) => ({ ...JSON.parse(e.payload), id: e.id, kind: e.kind }));
    const old = this.repo.get(
        "SELECT * FROM results WHERE chain=? AND address=?",
        chain,
        address,
      ),
      oldBase = this.repo.evidence(old.baseline_id);
    const bases = points
      .filter(
        (e) => e.kind === "baseline" && baselineDecision(e, c.at).accepted,
      )
      .map((e) => ({
        ...e,
        approximate: baselineDecision(e, c.at).approximate,
      }));
    // Exact anchor remains fixed. Approximate anchors may upgrade to exact evidence.
    const b =
      oldBase && !oldBase.revoked && !oldBase.approximate
        ? oldBase
        : (bases.sort(
            (a, b) =>
              Number(a.approximate) - Number(b.approximate) ||
              b.at - a.at ||
              a.id - b.id,
          )[0] ?? null);
    const peaks = points.filter((e) => e.kind === "peak");
    let formal = null,
      reference = null,
      low = null;
    for (const p of peaks) {
      const d = peakDecision(p, b, c.at, peaks);
      if (!d.accepted) continue;
      if (d.formal && (!formal || p.mc > formal.mc)) formal = p;
      if (!d.formal && (!reference || p.mc > reference.mc)) reference = p;
      if (!low || p.mc < low.mc) low = p;
    }
    for (const p of points.filter((e) => e.kind === "low")) {
      if (peakDecision(p, b, c.at, peaks).accepted && (!low || p.mc < low.mc))
        low = p;
    }
    const status = !c.verified
      ? "pending_token"
      : !b
        ? "missing_baseline"
        : formal
          ? "ready_exact"
          : reference
            ? "ready_approx"
            : "missing_peak";
    this.repo.run(
      "UPDATE results SET baseline_id=?,formal_peak_id=?,reference_peak_id=?,low_id=?,status=? WHERE chain=? AND address=? AND claim_version=?",
      b?.id ?? null,
      formal?.id ?? null,
      reference?.id ?? null,
      low?.id ?? null,
      status,
      chain,
      address,
      version,
    );
  }
  revoke(id, reason) {
    if (!reason?.trim()) throw Error("必须填写纠错原因");
    this.repo.transaction(() => {
      const e = this.repo.get("SELECT * FROM evidence WHERE id=?", id);
      if (!e) throw Error("证据不存在");
      this.repo.run("UPDATE evidence SET revoked=1 WHERE id=?", id);
      this.repo.diagnostic(
        "correction",
        `${e.chain}:${e.address}`,
        `evidence ${id}: ${reason}`,
      );
      this.recompute(e.chain, e.address, e.claim_version);
      this.repo.project();
    });
    this.changed();
  }
  publish() {
    this.repo.project();
    this.changed();
  }
}
