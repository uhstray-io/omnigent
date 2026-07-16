/**
 * Unique-id session tracking for spawned agent terminals (pure).
 *
 * Each `omnigent.openAgentTerminal` invocation must spawn an INDEPENDENT
 * terminal even for the same profile, so sessions are keyed by a unique
 * counter id rather than by profile name — that way repeated clicks open
 * concurrent terminals and Stop can target each one. Plain data logic with no
 * VS Code API so the keying / stop semantics can be unit-tested directly.
 */
export interface AgentSession<P, T> {
  id: number;
  profile: P;
  terminal: T;
}

export class SessionRegistry<P, T> {
  private next = 1;
  private readonly sessions = new Map<number, AgentSession<P, T>>();

  /** Register a new session; returns its unique id. */
  register(profile: P, terminal: T): number {
    const id = this.next++;
    this.sessions.set(id, { id, profile, terminal });
    return id;
  }

  get(id: number): AgentSession<P, T> | undefined {
    return this.sessions.get(id);
  }

  delete(id: number): boolean {
    return this.sessions.delete(id);
  }

  /** Find the session id whose terminal is `terminal` (identity check). */
  idOf(terminal: T): number | undefined {
    for (const [id, s] of this.sessions) {
      if (s.terminal === terminal) {
        return id;
      }
    }
    return undefined;
  }

  size(): number {
    return this.sessions.size;
  }

  values(): AgentSession<P, T>[] {
    return [...this.sessions.values()];
  }

  clear(): void {
    this.sessions.clear();
  }
}
