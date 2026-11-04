import { escapeMarkdown } from 'discord.js';
import { say } from './messages.js';
import { failureText } from './run-failure.js';
import { runHistory } from './automation-runs.js';

function sameExecution(a, b) { return JSON.stringify(a ?? null) === JSON.stringify(b ?? null); }

function timestamp(value) {
  return value ? new Date(value).toLocaleString('cs-CZ', { timeZone: 'Europe/Prague' }) : '—';
}

function statusText(status) {
  return ({ starting: 'zahajuje se', running: 'běží', completed: 'dokončeno', failed: 'chyba', interrupted: 'přerušeno' })[status] || status || 'neznámý';
}

function deliveryText(status) {
  return ({ pending: 'čeká na doručení', sent: 'doručeno', failed: 'doručení selhalo', unknown: 'výsledek doručení neznámý', suppressed: 'potlačeno jako nezměněné' })[status] || status || 'neznámé';
}

export class AutomationUI {
  constructor(bridge) { this.bridge = bridge; }

  async currentJob(channelId, id) {
    const job = this.bridge.store.state.schedules[id];
    if (!job || job.status === 'deleted' || job.discordId !== channelId || this.bridge.cleanup.isDeleted(channelId)) {
      throw new Error('Automatizace nebo její cíl již není dostupný. Otevři /automations znovu.');
    }
    await this.bridge.scheduler.delivery.destination('here', channelId);
    if (job.discordId !== channelId || job.status === 'deleted' || this.bridge.cleanup.isDeleted(channelId)) throw new Error('Automatizace se mezitím přesunula nebo byla smazána.');
    return job;
  }

  async effectiveExecution(job, channelId) {
    if (job.execution) return `Připnutý model: **${escapeMarkdown(job.execution.model)}** · uvažování: **${escapeMarkdown(job.execution.effort || 'výchozí')}**`;
    const selected = this.bridge.models.preference(channelId);
    let modelName = selected?.model || this.bridge.config.model || null;
    let effort = selected?.effort || null;
    if (!modelName) return 'Přebírá nastavení konverzace při každém spuštění.';
    if (!effort) {
      const models = await this.bridge.models.list().catch(() => []);
      effort = models.find(item => item.model === modelName)?.effort || null;
    }
    return `Dědí model: **${escapeMarkdown(modelName)}** · uvažování: **${escapeMarkdown(effort || 'výchozí')}**`;
  }

  async details(output, channelId, id) {
    try {
      const job = await this.currentJob(channelId, id);
      const execution = await this.effectiveExecution(job, channelId);
      const lastRun = runHistory(job)[0];
      const lines = [
        `**${escapeMarkdown(job.title)}**`,
        `Stav: ${job.status}${job.pendingRun ? ' · čeká ruční spuštění' : ''}`,
        execution,
        `Projekt: ${job.workspace?.projectId || 'původní workspace'} · ${job.workspace?.cwd || this.bridge.config.workspace || ''}`,
        `Cíl: <#${job.discordId}>`,
        `Upozornění: ${job.notificationMode === 'change' ? 'pouze při změně výsledku' : 'po každém dokončeném běhu'}`,
        `${job.status === 'enabled' ? 'Další termín' : 'Uložený termín (rozvrh neběží)'}: ${job.nextRun ? timestamp(job.nextRun) : 'žádný'}`,
        lastRun ? `Poslední běh: ${statusText(lastRun.status)} · ${deliveryText(lastRun.deliveryStatus)} · ${timestamp(lastRun.completedAt || lastRun.startedAt)}` : 'Zatím bez běhů.',
        job.lastFailure ? `Poslední chyba: ${escapeMarkdown(failureText(job.lastFailure))}` : '',
        job.pendingDestination ? `Čeká přesun do <#${job.pendingDestination}>.` : '',
        job.destinationError ? escapeMarkdown(job.destinationError) : '',
      ].filter(Boolean);

      const ui = this.bridge.ui;
      const buttons = [
        ui.button(channelId, 'Spustit nyní', async target => this.runNow(target, channelId, id)),
        ui.button(channelId, job.status === 'enabled' ? 'Pozastavit' : 'Zapnout', async target => this.toggle(target, channelId, id)),
        ui.button(channelId, 'Vybrat model', async target => this.chooseModel(target, channelId, id)),
        ui.button(channelId, job.notificationMode === 'change' ? 'Upozornění: změny' : 'Upozornění: vždy', async target => this.toggleNotifications(target, channelId, id)),
        ui.button(channelId, 'Historie běhů', async target => this.history(target, channelId, id)),
      ];
      const destinationButtons = [
        { ...ui.button(channelId, 'Stav konverzace', target => this.bridge.control('status', '', channelId, target, job.codexId)), disabled: !job.codexId },
      ];
      if (channelId !== this.bridge.config.channelId) destinationButtons.push(ui.button(channelId, 'Posílat do hlavního chatu', async target => {
        const current = await this.currentJob(channelId, id);
        const result = await this.bridge.scheduler.delivery.request(current, 'main', channelId);
        return say(target, result.note);
      }));
      if (job.pendingDestination) destinationButtons.push(ui.button(channelId, 'Zrušit změnu cíle', async target => {
        const current = await this.currentJob(channelId, id);
        const result = await this.bridge.scheduler.delivery.request(current, 'here', channelId);
        return say(target, result.note);
      }));
      return say(output, lines.join('\n'), { components: [{ type: 1, components: buttons }, { type: 1, components: destinationButtons }] });
    } catch (error) { return say(output, error.message); }
  }

  async runNow(output, channelId, id) {
    try {
      await this.currentJob(channelId, id);
      await this.bridge.scheduler.requestRun(id, channelId);
      return say(output, 'Ruční spuštění je zařazené. Další termín rozvrhu zůstává beze změny.');
    } catch (error) { return say(output, error.message); }
  }

  async toggle(output, channelId, id) {
    try {
      const job = await this.currentJob(channelId, id);
      const status = job.status === 'enabled' ? 'paused' : 'enabled';
      await this.bridge.scheduler.setStatus(id, status);
      return this.details(output, channelId, id);
    } catch (error) { return say(output, error.message); }
  }

  async toggleNotifications(output, channelId, id) {
    try {
      const job = await this.currentJob(channelId, id);
      await this.bridge.scheduler.configure(id, channelId, { notificationMode: job.notificationMode === 'change' ? 'always' : 'change' });
      return this.details(output, channelId, id);
    } catch (error) { return say(output, error.message); }
  }

  async chooseModel(output, channelId, id) {
    try {
      const job = await this.currentJob(channelId, id);
      const capturedExecution = job.execution ?? null;
      const models = await this.bridge.models.list();
      if (await this.currentJob(channelId, id) !== job || !sameExecution(job.execution, capturedExecution)) return say(output, 'Nastavení automatizace se mezitím změnilo. Otevři její detail znovu.');
      return this.bridge.ui.menu(output, channelId, 'Vyber model automatizace', [
        { value: '__inherit__', label: 'Dědit z konverzace', description: 'Přebírat model a uvažování při každém běhu.' },
        ...models.map(item => ({
          value: item.model,
          label: item.name.slice(0, 100),
          description: `${item.model}${item.efforts.length ? ` · ${item.effort || 'výchozí'}` : ' · bez volby uvažování'}`.slice(0, 100),
        }))], (target, modelId) => modelId === '__inherit__' ? this.inherit(target, channelId, id, capturedExecution) : this.chooseEffort(target, channelId, id, capturedExecution, modelId));
    } catch (error) { return say(output, error.message); }
  }

  async chooseEffort(output, channelId, id, capturedExecution, modelId) {
    try {
      const job = await this.currentJob(channelId, id);
      if (!sameExecution(job.execution, capturedExecution)) return say(output, 'Nastavení modelu se mezitím změnilo. Otevři detail znovu.');
      const models = await this.bridge.models.list();
      const selected = models.find(item => item.model === modelId);
      if (!selected) return say(output, 'Model již není v nabídce Codexu. Otevři detail znovu.');
      if (!selected.efforts.length) {
        await this.currentJob(channelId, id);
        if (!sameExecution(job.execution, capturedExecution)) return say(output, 'Nastavení modelu se mezitím změnilo. Otevři detail znovu.');
        await this.bridge.scheduler.configure(id, channelId, { execution: { model: selected.model, effort: null } });
        return this.details(output, channelId, id);
      }
      const options = [
        { value: '__default__', label: `Výchozí (${selected.effort || 'Codex'})`, description: 'Výchozí úroveň tohoto modelu'.slice(0, 100) },
        ...selected.efforts.map(item => ({ value: item.effort, label: item.effort.slice(0, 100), description: (item.description || `Úroveň uvažování: ${item.effort}`).slice(0, 100) })),
      ];
      return this.bridge.ui.menu(output, channelId, `Úroveň uvažování · ${selected.name}`, options, async (target, effort) => {
        const current = await this.currentJob(channelId, id);
        if (!sameExecution(current.execution, capturedExecution)) return say(target, 'Nastavení modelu se mezitím změnilo. Otevři detail znovu.');
        const valid = await this.bridge.models.list();
        const freshModel = valid.find(item => item.model === modelId);
        if (!freshModel || (effort !== '__default__' && !freshModel.efforts.some(item => item.effort === effort))) return say(target, 'Volba modelu již není platná. Otevři detail znovu.');
        await this.bridge.scheduler.configure(id, channelId, { execution: { model: modelId, effort: effort === '__default__' ? freshModel.effort : effort } });
        return this.details(target, channelId, id);
      });
    } catch (error) { return say(output, error.message); }
  }

  async inherit(output, channelId, id, expectedExecution) {
    try {
      const job = await this.currentJob(channelId, id);
      if (expectedExecution !== undefined && !sameExecution(job.execution, expectedExecution)) return say(output, 'Nastavení modelu se mezitím změnilo. Otevři detail znovu.');
      await this.bridge.scheduler.configure(id, channelId, { execution: null });
      return this.details(output, channelId, id);
    } catch (error) { return say(output, error.message); }
  }

  async history(output, channelId, id) {
    try {
      const job = await this.currentJob(channelId, id);
      const runs = runHistory(job);
      return this.bridge.ui.menu(output, channelId, 'Historie běhů automatizace', runs.map(run => ({
        value: run.id,
        label: `${statusText(run.status)} · ${timestamp(run.completedAt || run.startedAt)}`.slice(0, 100),
        description: `${run.kind === 'manual' ? 'Ruční' : 'Podle rozvrhu'} · ${deliveryText(run.deliveryStatus)}`.slice(0, 100),
      })), (target, runId) => this.runDetails(target, channelId, id, runId));
    } catch (error) { return say(output, error.message); }
  }

  async runDetails(output, channelId, id, runId) {
    try {
      const job = await this.currentJob(channelId, id);
      const run = runHistory(job).find(item => item.id === runId);
      if (!run) return say(output, 'Tento běh již není v historii.');
      const lines = [
        `Běh: ${statusText(run.status)} · ${run.kind === 'manual' ? 'ruční' : 'podle rozvrhu'}`,
        `Začátek: ${timestamp(run.startedAt)} · konec: ${timestamp(run.completedAt)}`,
        `Konverzace: ${run.turnId || 'bez ID tahu'}`,
        `Doručení: ${deliveryText(run.deliveryStatus)}`,
        run.execution?.model ? `Použitý model: ${escapeMarkdown(run.execution.model)} · uvažování: ${escapeMarkdown(run.execution.effort || 'výchozí')}` : 'Model převzatý z nastavení konverzace.',
        run.result ? `Výsledek: ${run.result.status} · ${escapeMarkdown(run.result.key)}${run.result.summary ? `\n${escapeMarkdown(run.result.summary)}` : ''}` : '',
        run.failure ? `Chyba: ${escapeMarkdown(failureText(run.failure))}` : '',
        run.deliveryError ? `Chyba doručení: ${escapeMarkdown(run.deliveryError)}` : '',
      ].filter(Boolean);
      return output.send({ content: lines.join('\n'), components: [{ type: 1, components: [this.bridge.ui.button(channelId, 'Zpět do historie', target => this.history(target, channelId, id))] }] });
    } catch (error) { return say(output, error.message); }
  }
}
