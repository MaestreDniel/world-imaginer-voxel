/**
 * WorldSession (SP2a spec §4.3): the world the page shows — seed text, profile, patch over the
 * profile, the resolved params and an epoch that bumps only when the seed or the params change.
 * SP2b's panel and editors edit the same session.
 */
import { hex64, type Seed64 } from '../core/hash';
import { applyPatch, type Issue } from '../core/params/kit';
import { isProfileReady, resolveProfile, type ProfileId } from '../core/params/profiles';
import { SCHEMA, type Params, type ParamsPatch } from '../core/params/schema';
import { resolveSeedText } from '../core/seed';
import { paramsHash } from '../core/stage/hash';

export interface SessionState {
  readonly seedText: string;
  readonly seed: Seed64;
  readonly profile: ProfileId;
  readonly patch: ParamsPatch;
  readonly params: Params;
  readonly epoch: number;
}

export type SessionResult = { readonly ok: true; readonly state: SessionState } | { readonly ok: false; readonly issues: readonly Issue[] };

const issue = (path: string, message: string): Issue => ({ path, code: 'BAD_ENUM', message });

export class WorldSession {
  private readonly random: () => Seed64;
  private s: SessionState;
  private key: string;

  constructor(random: () => Seed64, init: { seedText?: string; profile?: ProfileId; patch?: ParamsPatch } = {}) {
    this.random = random;
    const seed = resolveSeedText(init.seedText ?? '', random);
    const profile = init.profile !== undefined && isProfileReady(init.profile) ? init.profile : 'default';
    const r = applyPatch(SCHEMA, resolveProfile(profile), init.patch ?? {});
    const patch = r.ok ? (init.patch ?? {}) : {};
    const params = r.ok ? r.value : resolveProfile(profile);
    this.s = { seedText: seed.text, seed: seed.seed, profile, patch, params, epoch: 0 };
    this.key = this.keyOf(this.s);
  }

  get state(): SessionState {
    return this.s;
  }

  private keyOf(s: Pick<SessionState, 'seed' | 'params'>): string {
    return `${s.seed[0]}|${s.seed[1]}|${hex64(paramsHash(s.params))}`;
  }

  private commit(next: Omit<SessionState, 'epoch'>): SessionState {
    const key = this.keyOf(next);
    this.s = { ...next, epoch: key === this.key ? this.s.epoch : this.s.epoch + 1 };
    this.key = key;
    return this.s;
  }

  /** SP1 seed rule; returns the state (seedText holds the written-back random seed for empty text). */
  setSeedText(text: string): SessionState {
    const r = resolveSeedText(text, this.random);
    return this.commit({ ...this.s, seedText: r.text, seed: r.seed });
  }

  /** Switches to a ready profile and clears the patch (the UI asks for confirmation first). */
  setProfile(profile: ProfileId): SessionResult {
    if (!isProfileReady(profile)) return { ok: false, issues: [issue('profile', `profile ${profile} is not available yet`)] };
    return { ok: true, state: this.commit({ ...this.s, profile, patch: {}, params: resolveProfile(profile) }) };
  }

  /** Replaces the patch over the profile; an invalid patch changes nothing. */
  setPatch(patch: unknown): SessionResult {
    const r = applyPatch(SCHEMA, resolveProfile(this.s.profile), patch);
    if (!r.ok) return { ok: false, issues: r.issues };
    return { ok: true, state: this.commit({ ...this.s, patch: patch as ParamsPatch, params: r.value }) };
  }
}
