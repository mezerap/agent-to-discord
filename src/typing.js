export class TypingIndicator {
  constructor({ channels, isWorking, onMissing }) {
    Object.assign(this, { channels, isWorking, onMissing });
    this.sessions = new Map();
  }

  start(id) {
    if (this.sessions.has(id) || !this.isWorking(id)) return;
    const session = { pending: false };
    this.sessions.set(id, session);
    session.timer = setInterval(() => { void this.pulse(id, session); }, 8_000);
    session.timer.unref();
    void this.pulse(id, session);
  }

  async pulse(id, session) {
    if (this.sessions.get(id) !== session) return;
    if (!this.isWorking(id)) { this.stop(id); return; }
    if (session.pending) return;
    session.pending = true;
    try {
      const channel = await this.channels.fetch(id);
      if (this.sessions.get(id) === session && this.isWorking(id)) await channel.sendTyping();
    } catch (error) {
      // A typing indicator must never prevent an actual task from starting or completing.
      if (error?.code === 10003) { this.stop(id); this.onMissing(id); }
    } finally { session.pending = false; }
  }

  stop(id) {
    clearInterval(this.sessions.get(id)?.timer);
    this.sessions.delete(id);
  }

  close() {
    for (const id of this.sessions.keys()) this.stop(id);
  }
}
