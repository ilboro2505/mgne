import type { Config, NetworkEvent, Snapshot } from './contracts';

export interface HistoryEvent extends NetworkEvent {
  /** One-based per-neuron ordinal since the explicit observation epoch. */
  ordinals: Record<string, number>;
  /** Absolute event group count in the simulation; independent of chart clearing. */
  groupIndex: number;
}
export interface PotentialSample { time: number; values: Record<string, number> }
export interface PairSelection { source: string; target: string; sourceOffset: 0 | 1; targetOffset: 0 | 1 }
export type ChartTab = 'spikes' | 'potential' | 'difference';
export interface ChartContext {
  config: Config;
  snapshot: Snapshot | null;
  selected: string;
  events: HistoryEvent[];
  samples: PotentialSample[];
  tab: ChartTab;
  pair: PairSelection;
  totalSpikes: number;
  omittedEvents: number;
  epochTime: number;
}

const el = (id: string): HTMLElement => document.getElementById(id)!;
const escape = (value: unknown): string => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const number = (value: number, digits = 3): string => Number.isFinite(value) ? value.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: digits }) : '—';
const shortId = (id: string): string => id.length > 8 ? `${id.slice(0, 7)}…` : id;

/** Join by the retained ordinals, never re-index a truncated spike train. */
export function pairDifferences(events: HistoryEvent[], pair: PairSelection): { index: number; value: number }[] {
  const source = new Map<number, number>(), target = new Map<number, number>();
  for (const event of events) {
    for (const id of event.spikes) {
      if (id === pair.source) source.set(event.ordinals[id], event.time);
      if (id === pair.target) target.set(event.ordinals[id], event.time);
    }
  }
  const points: { index: number; value: number }[] = [];
  for (const [ordinal, time] of source) {
    const index = ordinal - pair.sourceOffset;
    const otherTime = target.get(index + pair.targetOffset);
    if (index >= 1 && otherTime !== undefined) points.push({ index, value: otherTime - time });
  }
  return points.sort((a, b) => a.index - b.index);
}

export function renderCharts(context: ChartContext, onPairChange: (pair: PairSelection) => void): void {
  const { tab, totalSpikes, omittedEvents, epochTime } = context;
  el('chart-count').textContent = `${number(totalSpikes, 0)} спайков`;
  el('chart-count').title = `Всего с начала наблюдения, t = ${number(epochTime, 6)}`;
  el('chart').classList.toggle('is-hidden', tab === 'difference');
  el('phase').classList.toggle('is-hidden', tab !== 'difference');
  el('phase').parentElement?.classList.toggle('is-difference', tab === 'difference');
  if (tab === 'difference') { renderDifference(context, onPairChange); return; }
  const { config, snapshot, selected, events, samples } = context;
  const width = Math.max(280, el('chart').clientWidth), height = 180, left = 44, top = 12, right = 14, bottom = 23;
  el('chart').setAttribute('viewBox', `0 0 ${width} ${height}`);
  const earliest = tab === 'spikes' ? events[0]?.time ?? epochTime : samples[0]?.time ?? epochTime;
  const latest = snapshot?.time ?? epochTime;
  const start = Math.max(0, earliest), end = Math.max(start + 1e-6, latest);
  const x = (time: number) => left + (time - start) / (end - start) * (width - left - right);
  let svg = '';
  for (let tick = 0; tick <= 5; tick++) {
    const tx = left + tick * (width - left - right) / 5;
    svg += `<line x1="${tx}" y1="${top}" x2="${tx}" y2="${height - bottom}" class="chart-grid"/><text x="${tx}" y="${height - 4}" text-anchor="${tick === 0 ? 'start' : tick === 5 ? 'end' : 'middle'}" class="chart-axis">${number(start + tick * (end - start) / 5, 2)}</text>`;
  }
  if (tab === 'spikes') {
    const count = config.neurons.length;
    const y = (index: number) => top + (index + .5) * (height - top - bottom) / count;
    const markHeight = Math.max(1.5, Math.min(5, 45 / count));
    const ids = new Map(config.neurons.map((neuron, index) => [neuron.id, index]));
    config.neurons.forEach((neuron, index) => {
      svg += `<line x1="${left}" y1="${y(index)}" x2="${width - right}" y2="${y(index)}" class="chart-grid"/>`;
      if (count <= 12 || index % Math.ceil(count / 10) === 0) svg += `<text x="${left - 9}" y="${y(index) + 3}" text-anchor="end" class="chart-axis">${escape(shortId(neuron.id))}</text>`;
    });
    for (const event of events) for (const id of event.spikes) {
      const index = ids.get(id);
      if (index === undefined) continue;
      svg += `<line x1="${x(event.time)}" y1="${y(index) - markHeight}" x2="${x(event.time)}" y2="${y(index) + markHeight}" class="chart-spike${id === selected ? ' selected' : ''}"/>`;
    }
    el('chart-empty').classList.toggle('is-hidden', events.some((event) => event.spikes.length > 0));
    el('chart-caption').textContent = omittedEvents > 0 ? `Последние 1000 групп событий; предыдущие ${omittedEvents} скрыты.` : 'Каждая отметка — спайк. Выбранный нейрон выделен коралловым.';
  } else {
    const values = samples.map((sample) => sample.values[selected]).filter(Number.isFinite);
    const min = Math.min(-1, ...values), max = Math.max(config.parameters.threshold * 1.05, ...values, 1);
    const y = (value: number) => top + (max - value) / (max - min) * (height - top - bottom);
    for (let tick = 0; tick <= 3; tick++) {
      const value = min + tick * (max - min) / 3;
      svg += `<line x1="${left}" y1="${y(value)}" x2="${width - right}" y2="${y(value)}" class="chart-grid"/><text x="${left - 7}" y="${y(value) + 3}" text-anchor="end" class="chart-axis">${number(value, 1)}</text>`;
    }
    const thresholdY = y(config.parameters.threshold);
    svg += `<line x1="${left}" y1="${thresholdY}" x2="${width - right}" y2="${thresholdY}" class="chart-threshold"/><text x="${width - right}" y="${thresholdY - 4}" text-anchor="end" class="chart-axis">p = ${number(config.parameters.threshold)}</text>`;
    const points = samples.filter((sample) => Number.isFinite(sample.values[selected])).map((sample) => `${x(sample.time)},${y(sample.values[selected])}`);
    if (points.length) svg += `<polyline points="${points.join(' ')}" class="chart-trace"/>`;
    el('chart-empty').classList.toggle('is-hidden', samples.length >= 2);
    el('chart-caption').textContent = `Нейрон ${shortId(selected)} · состояния после команд; линии соединяют отсчёты, не показывают точную траекторию.`;
  }
  el('chart-range').textContent = 'Время →';
  el('chart').innerHTML = svg;
}

function renderDifference(context: ChartContext, onPairChange: (pair: PairSelection) => void): void {
  const { config, pair, events, epochTime } = context;
  el('chart-empty').classList.add('is-hidden');
  const options = (current: string) => config.neurons.map((neuron) => `<option value="${escape(neuron.id)}" ${neuron.id === current ? 'selected' : ''}>${escape(shortId(neuron.id))}</option>`).join('');
  const offsets = (current: number) => `<option value="0" ${current === 0 ? 'selected' : ''}>i</option><option value="1" ${current === 1 ? 'selected' : ''}>i + 1</option>`;
  const points = pairDifferences(events, pair);
  const latest = points.at(-1);
  const formula = `t₂(i${pair.targetOffset ? ' + 1' : ''}) − t₁(i${pair.sourceOffset ? ' + 1' : ''})`;
  el('phase').innerHTML = `<div class="phase-selectors"><label class="phase-pair"><span>Нейрон 1</span><select id="phase-source" aria-label="Первый нейрон для разности времён">${options(pair.source)}</select><select id="phase-source-offset" aria-label="Индекс спайка первого нейрона">${offsets(pair.sourceOffset)}</select></label><label class="phase-pair"><span>Нейрон 2</span><select id="phase-target" aria-label="Второй нейрон для разности времён">${options(pair.target)}</select><select id="phase-target-offset" aria-label="Индекс спайка второго нейрона">${offsets(pair.targetOffset)}</select></label><div class="phase-readout"><span>Δt · ${escape(formula)}</span><strong>${latest ? escape(number(latest.value, 6)) : '—'}</strong></div></div><svg id="phase-chart" class="phase-chart" viewBox="0 0 700 145" preserveAspectRatio="none" role="img" aria-label="Разность времён спайков по порядковому номеру"></svg>${points.length ? '' : '<div class="phase-help">Недостаточно спайков для выбранных индексов. Запустите расчёт.</div>'}`;
  for (const id of ['phase-source', 'phase-target', 'phase-source-offset', 'phase-target-offset']) {
    el(id).addEventListener('change', () => {
      const value = (key: string) => (el(key) as HTMLSelectElement).value;
      onPairChange({ source: value('phase-source'), target: value('phase-target'), sourceOffset: Number(value('phase-source-offset')) as 0 | 1, targetOffset: Number(value('phase-target-offset')) as 0 | 1 });
    });
  }
  const width = Math.max(280, el('phase-chart').clientWidth);
  el('phase-chart').setAttribute('viewBox', `0 0 ${width} 145`);
  el('phase-chart').innerHTML = differenceSvg(points, width);
  el('chart-caption').textContent = `Индексы от начала наблюдения (t = ${number(epochTime, 3)}); сохраняются при обрезке истории. Δt — не нормированная фаза.`;
  el('chart-range').textContent = `${points.length} пар · i →`;
}

function differenceSvg(points: { index: number; value: number }[], width: number): string {
  if (!points.length) return '';
  const left = 65, right = 14, top = 10, bottom = 24, height = 145;
  const start = points[0].index, end = Math.max(start + 1, points.at(-1)!.index);
  const values = points.map((point) => point.value);
  let min = Math.min(...values), max = Math.max(...values);
  const padding = Math.max((max - min) * .1, Math.abs(max) * 1e-6, 1e-10);
  min -= padding;
  max += padding;
  const x = (index: number) => left + (index - start) / (end - start) * (width - left - right);
  const y = (value: number) => top + (max - value) / (max - min) * (height - top - bottom);
  let svg = '';
  const yLabel = (value: number) => Math.abs(value) > 0 && (Math.abs(value) < .001 || Math.abs(value) > 1e5) ? value.toExponential(2) : number(value, 5);
  for (let tick = 0; tick <= 3; tick++) {
    const value = min + tick * (max - min) / 3;
    svg += `<line x1="${left}" y1="${y(value)}" x2="${width - right}" y2="${y(value)}" class="chart-grid"/><text x="${left - 8}" y="${y(value) + 3}" text-anchor="end" class="chart-axis">${yLabel(value)}</text>`;
  }
  const indices = new Set(Array.from({ length: 6 }, (_, tick) => Math.round(start + tick * (end - start) / 5)));
  for (const index of indices) svg += `<line x1="${x(index)}" y1="${top}" x2="${x(index)}" y2="${height - bottom}" class="chart-grid"/><text x="${x(index)}" y="${height - 5}" text-anchor="middle" class="chart-axis">${index}</text>`;
  // Gaps mean that one member of a pair is absent from the retained history.
  const segments: string[][] = [[]];
  points.forEach((point, index) => {
    if (index && point.index !== points[index - 1].index + 1) segments.push([]);
    segments.at(-1)!.push(`${x(point.index)},${y(point.value)}`);
  });
  for (const segment of segments) svg += `<polyline points="${segment.join(' ')}" class="chart-trace"/>`;
  if (points.length <= 40) for (const point of points) svg += `<circle cx="${x(point.index)}" cy="${y(point.value)}" r="2" fill="var(--teal)"><title>i=${point.index}; Δt=${point.value}</title></circle>`;
  return svg;
}
