import { say } from './messages.js';

export const MAIN_IDLE_MS = 24 * 60 * 60 * 1000;
export const CONTEXT_WARNING_TOKENS = 30_000;

export class IdleContext {
  constructor(bridge, now = Date.now) {
    this.bridge = bridge; this.now = now;
    const main = bridge.store.state.threads[bridge.config.channelId];
    if (main && !Number.isFinite(main.lastActivityAt)) main.lastActivityAt = now();
  }
  touch(record) { if (record?.kind === 'main') record.lastActivityAt = this.now(); }

  async beforeMessage(channel, record) {
    if (record?.kind === 'main' && this.now() - record.lastActivityAt >= MAIN_IDLE_MS &&
      this.now() - (record.idleWarningAt || 0) >= MAIN_IDLE_MS) {
      record.idleWarningAt = this.now(); await this.bridge.store.save();
      await say(channel, 'Od poslední aktivity uběhlo 24 hodin. Pokračuji ve stejném kontextu. Pro nový použij /new, nebo mi napiš, která témata chceš zachovat či přesunout do vlákna. Bez potvrzení nic nearchivuji.').catch(() => { console.error('Inactivity notice unavailable; conversation preserved.'); });
    }
    return record;
  }

  async update(record, usage) {
    const input = usage?.last?.inputTokens;
    if (!Number.isFinite(input) || input < 0) return;
    record.contextUsage = { inputTokens: input, modelContextWindow: usage.modelContextWindow ?? null,
      totalTokens: usage.total?.totalTokens ?? null, at: this.now() };
    await this.bridge.store.save();
  }

  async warn(record) {
    if (record.kind !== 'main' || (record.contextUsage?.inputTokens || 0) < CONTEXT_WARNING_TOKENS) return;
    if (record.contextWarningAt && this.now() - record.contextWarningAt < MAIN_IDLE_MS) return;
    record.contextWarningAt = this.now(); await this.bridge.store.save();
    const channel = await this.bridge.discord.channels.fetch(record.discordId);
    await say(channel, `Kontext posledního vstupu má přibližně ${record.contextUsage.inputTokens.toLocaleString('cs-CZ')} tokenů (hranice upozornění 30 000). Zatím pokračuji ve stejném chatu. Můžeš napsat „archivuj, ale zachovej témata X a Y“ nebo požádat o přenos do vlákna. Návrh nejprve ukážu k potvrzení. /new začne čistě bez zachování témat.`);
  }

  status(record) {
    const u = record?.contextUsage;
    if (!u) return 'Velikost kontextu: Codex ji zatím neohlásil.';
    const percent = u.modelContextWindow > 0 ? ` (~${Math.round(u.inputTokens / u.modelContextWindow * 100)} % kapacity)` : '';
    return `Poslední vstup: ${u.inputTokens.toLocaleString('cs-CZ')} tokenů${percent}. Hranice upozornění: 30 000. Součet spotřeby: ${u.totalTokens ?? 'neznámý'} tokenů. Údaj zahrnuje historii, instrukce a nástroje; nejde o velikost příštího požadavku.`;
  }
}
