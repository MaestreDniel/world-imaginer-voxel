// Types for shardLib.mjs (the test tsconfig has no allowJs; SP4b spec §1.1).
export type Shards = Record<string, string[] | null>;

export interface ShardTool {
  matrix(): string[];
  check(): void;
  run(name: string, report: string): never;
}

export function shardArgs(shards: Shards, name: string): string[];

export function coverageProblems(o: {
  project: string;
  shards: Shards;
  all: string[];
  onDisk: string[];
  listed: Record<string, string[]>;
}): string[];

export function shardTool(o: { project: string; dir: string; suffix: string; shards: Shards }): ShardTool;

export function cli(url: string, tool: ShardTool, script: string): void;
