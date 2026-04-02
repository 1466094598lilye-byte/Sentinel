export type ArtifactKind =
  | "pm_research"
  | "pm_tier"
  | "pm_cross"
  | "pm_merge"
  | "tester_system"
  | "tester_user"
  | "hack_skill"
  | "hack_cross"
  | "hack_merge";

export interface ArtifactFilter {
  kind?: ArtifactKind;
  round?: number;
  tier?: number;
  skill?: number;
}

export interface IsolationArtifact {
  id: string;
  kind: ArtifactKind;
  content: string;
  createdAt: number;
  round?: number;
  tier?: number;
  skill?: number;
}

function matchesFilter(artifact: IsolationArtifact, filter: ArtifactFilter): boolean {
  if (filter.kind && artifact.kind !== filter.kind) return false;
  if (filter.round !== undefined && artifact.round !== filter.round) return false;
  if (filter.tier !== undefined && artifact.tier !== filter.tier) return false;
  if (filter.skill !== undefined && artifact.skill !== filter.skill) return false;
  return true;
}

export class IsolationVault {
  private artifacts = new Map<string, IsolationArtifact[]>();
  private counters = new Map<string, number>();

  store(
    sessionKey: string,
    kind: ArtifactKind,
    content: string,
    meta: Omit<ArtifactFilter, "kind"> = {},
  ): IsolationArtifact {
    const next = (this.counters.get(sessionKey) || 0) + 1;
    this.counters.set(sessionKey, next);

    const artifact: IsolationArtifact = {
      id: `${kind}:${String(next).padStart(4, "0")}`,
      kind,
      content,
      createdAt: Date.now(),
      ...meta,
    };

    const existing = this.artifacts.get(sessionKey) || [];
    existing.push(artifact);
    this.artifacts.set(sessionKey, existing);
    return artifact;
  }

  list(sessionKey: string, filter: ArtifactFilter = {}): IsolationArtifact[] {
    const artifacts = this.artifacts.get(sessionKey) || [];
    return artifacts
      .filter((artifact) => matchesFilter(artifact, filter))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  latest(sessionKey: string, filter: ArtifactFilter = {}): IsolationArtifact | undefined {
    const artifacts = this.list(sessionKey, filter);
    return artifacts[artifacts.length - 1];
  }
}

export function describeArtifact(artifact: IsolationArtifact): string {
  const dims: string[] = [];
  if (artifact.round !== undefined) dims.push(`round ${artifact.round}`);
  if (artifact.tier !== undefined) dims.push(`tier ${artifact.tier}`);
  if (artifact.skill !== undefined) dims.push(`skill ${artifact.skill}`);
  return dims.length > 0
    ? `${artifact.id} (${artifact.kind}; ${dims.join(", ")})`
    : `${artifact.id} (${artifact.kind})`;
}

export function formatIsolationCapsule(title: string, lines: string[]): string {
  return [
    `## Isolation Capsule`,
    `- Phase: ${title}`,
    ...lines.map((line) => `- ${line}`),
  ].join("\n");
}
