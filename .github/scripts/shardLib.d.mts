// Types for shardLib.mjs (the test tsconfig has no allowJs; SP4b spec §1.1).
/**
 * A shard: its files; its files with the env its run sets (SP6b spec §13: a file in several shards whose envs
 * partition it); or the catch-all (null).
 */
export type Shard = string[] | { files: string[]; env: Record<string, string> } | null;
export type Shards = Record<string, Shard>;

export interface ShardTool {
  matrix(): string[];
  check(): void;
  run(name: string, report: string): never;
}

export function shardArgs(shards: Shards, name: string): string[];

export function shardEnv(shards: Shards, name: string): Record<string, string>;

export function coverageProblems(o: {
  project: string;
  shards: Shards;
  all: string[];
  onDisk: string[];
  listed: Record<string, string[]>;
}): string[];

export function shardTool(o: { project: string; dir: string; suffix: string; shards: Shards }): ShardTool;

export function cli(url: string, tool: ShardTool, script: string): void;
