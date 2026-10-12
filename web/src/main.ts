import './style.css';
import { EngineClient } from './engine';
import type { Config, RunResult, Snapshot } from './contracts';
import { PRESETS } from './presets';
import { renderCharts, type ChartTab, type HistoryEvent, type PairSelection, type PotentialSample } from './charts';

const icons = {
  play: '<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M6 3.7v12.6L16 10z"/></svg>',
  pause: '<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M5 4h3v12H5zm7 0h3v12h-3z"/></svg>',
  step: '<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M4 4v12l9-6zM14 4h2v12h-2z"/></svg>',
  reset: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M4 8a6 6 0 1 1 0 5M4 3v5h5"/></svg>',
  import: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M10 2v10m-4-4 4 4 4-4M4 13v4h12v-4"/></svg>',
  export: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M10 12V2M6 6l4-4 4 4M4 13v4h12v-4"/></svg>',
  add: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M10 4v12M4 10h12"/></svg>',
};

const MAX_NEURONS = 128;
const MAX_HISTORY = 1000;
const escape = (value: unknown): string => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const clone = <T,>(value: T): T => structuredClone(value);
const number = (value: number, digits = 3): string => Number.isFinite(value) ? value.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: digits }) : '—';
const compact = (value: number): string => Math.abs(value) > 0 && Math.abs(value) < .001 ? value.toExponential(2) : number(value, 3);
const shortId = (id: string): string => id.length > 8 ? `${id.slice(0, 7)}…` : id;
const edgeKey = (source: string, target: string): string => JSON.stringify([source, target]);
const el = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const engine = new EngineClient();
let config = clone(PRESETS[0].config);
let result: RunResult | null = null;
let selected = config.neurons[0]?.id ?? '';
let dirty = false;
let busy = false;
let running = false;
let operation = 0;
let errorMessage = '';
let events: HistoryEvent[] = [];
let samples: PotentialSample[] = [];
let chartTab: ChartTab = 'spikes';
let graphTab: 'graph' | 'matrix' = 'graph';
let pair: PairSelection = { source: config.neurons[0]?.id ?? '', target: config.neurons[1]?.id ?? config.neurons[0]?.id ?? '', sourceOffset: 0, targetOffset: 0 };
const spikeOrdinals = new Map<string, number>();
let epochTime = 0;
let totalSpikes = 0;
let omittedEvents = 0;
const positions = new Map<string, { x: number; y: number }>();

el('app').innerHTML = `
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <div class="brand-mark"><svg viewBox="0 0 36 36" fill="none" aria-hidden="true"><path d="m10 9 17 3-5 17L7 23Z" stroke="currentColor" stroke-width="1.2"/><path d="m10 9 12 20M7 23l20-11" stroke="currentColor" stroke-width="1.2"/><circle cx="10" cy="9" r="3" fill="currentColor"/><circle cx="27" cy="12" r="3" fill="currentColor"/><circle cx="22" cy="29" r="3" fill="currentColor"/><circle cx="7" cy="23" r="3" fill="currentColor"/></svg></div>
        <div><div class="brand-title">МОНЭ<span style="color:#93a49a;font-weight:400"> / </span>lab</div><div class="brand-subtitle">Лаборатория нейронной сети</div></div>
      </div>
      <div class="header-actions">
        <span class="engine-label"><span class="dot"></span> RUST · WASM</span>
        <button id="import" title="Импорт конфигурации или снимка" aria-label="Импорт конфигурации или снимка" data-config-edit>${icons.import} Импорт</button>
        <div class="export-menu"><button id="export-toggle" aria-expanded="false" aria-controls="export-options" aria-label="Экспорт данных">${icons.export} Экспорт</button>
          <div id="export-options" class="export-options is-hidden">
            <button id="export-config">Конфигурация · JSON</button><button id="export-snapshot" data-needs-ready>Снимок состояния · JSON</button><button id="export-events" data-needs-ready>События в окне · CSV</button>
          </div>
        </div>
        <input type="file" id="import-file" accept=".json,application/json" hidden />
      </div>
    </header>
    <section class="intro"><div><span class="eyebrow">Экспериментальная среда / 01</span><h1>Наблюдайте, как возникает ритм.</h1><p>Соберите сеть, задайте начальные условия и исследуйте её динамику.</p></div><span class="session-label"><span class="dot"></span> Локальный эксперимент</span></section>
    <div id="error" class="error-banner is-hidden" role="alert"><span id="error-text"></span><button id="dismiss-error" aria-label="Закрыть сообщение об ошибке">×</button></div>
    <main class="workspace">
      <aside class="left-column">
        <div class="panel left-panel">
          <section class="section preset-section"><div class="section-heading"><h2>Эксперимент</h2><span class="section-index">01</span></div>
            <label class="small-label" for="preset">Начальная конфигурация</label><select id="preset" data-config-edit>${PRESETS.map((preset) => `<option value="${escape(preset.id)}">${escape(preset.name)}</option>`).join('')}<option value="custom" disabled>Своя конфигурация</option></select>
            <p id="preset-description" class="help">${escape(PRESETS[0].description)}</p>
          </section>
          <section class="section parameter-section"><div class="section-heading"><h2>Параметры модели</h2><span class="section-index">02</span></div>
            <div class="field-grid">
              <label class="field"><span class="field-label">Порог <span class="symbol">p</span></span><input id="threshold" aria-label="Порог p" type="number" min="0" step="any" data-config-edit /></label>
              <label class="field"><span class="field-label">Покой <span class="symbol">r</span></span><input id="rest" aria-label="Потенциал покоя r" type="number" min="0" step="any" data-config-edit /></label>
              <label class="field"><span class="field-label">Скорость <span class="symbol">α</span></span><input id="alpha" aria-label="Скорость alpha" type="number" min="0" step="any" data-config-edit /></label>
              <label class="field"><span class="field-label">Рефрактерность <span class="symbol">Tᵣ</span></span><input id="refractoryPeriod" aria-label="Рефрактерный период" type="number" min="0" step="any" data-config-edit /></label>
            </div>
            <div id="model-note" class="model-note"></div>
            <button id="apply" class="full-width apply-button is-hidden" data-config-edit>Применить и сбросить</button>
          </section>
          <section class="transport"><div class="section-heading"><h2>Управление</h2><span class="section-index">03</span></div>
            <button id="run" class="main-run button-primary full-width">${icons.play} Запустить</button>
            <div class="control-row"><button id="step" data-needs-ready>${icons.step} Один шаг</button><button id="reset" class="button-quiet" title="Сбросить к начальным условиям" aria-label="Сбросить к начальным условиям" data-config-edit>${icons.reset}</button></div>
            <div class="step-row"><button id="batch-100" data-needs-ready>+100</button><button id="batch-1000" data-needs-ready>+1000</button><button id="clear-charts" title="Очистить окно графиков" data-needs-ready>Очистить</button></div>
            <div id="status" class="state-strip" role="status" aria-live="polite"><span class="dot"></span><span id="status-text">Загрузка ядра…</span></div>
            <p class="help">Шаг — ближайшая группа одновременных событий сети.</p>
          </section>
        </div>
        <div class="aside-footer"><strong>Непрерывное время.</strong><br />Расчёт переходит от события к событию; частота отрисовки не меняет динамику.</div>
      </aside>
      <div class="main-column">
        <section class="panel">
          <div class="panel-heading"><div class="tabs" role="tablist" aria-label="Представление сети"><button id="tab-graph" class="tab active" role="tab" aria-selected="true" aria-controls="graph-content">Топология</button><button id="tab-matrix" class="tab" role="tab" aria-selected="false" aria-controls="matrix-content">Матрица весов</button></div><div class="panel-tools"><button id="add-neuron" data-config-edit>${icons.add} Нейрон</button><button id="fully-connect" data-config-edit title="Добавить отсутствующие связи весом 1">Связать все</button></div></div>
          <div class="metrics"><div class="metric"><div class="metric-label">МОДЕЛЬНОЕ ВРЕМЯ</div><div class="metric-value"><span id="time-value">0.000</span><span class="metric-unit">t</span></div></div><div class="metric"><div class="metric-label">ГРУППЫ СОБЫТИЙ</div><div id="event-value" class="metric-value metric-value-small">0</div></div><div class="metric"><div class="metric-label">НЕЙРОНЫ / СВЯЗИ</div><div id="network-value" class="metric-value metric-value-small"></div></div></div>
          <div id="graph-content" class="topology-wrap" role="tabpanel" aria-labelledby="tab-graph"><svg id="topology" class="topology-svg" viewBox="0 0 700 430" role="img" aria-label="Граф связей нейронной сети"></svg><div id="graph-scope" class="graph-scope is-hidden">Показаны связи выбранного нейрона. Все связи — в матрице.</div><div class="topology-footer"><div class="legend"><span class="legend-item"><span class="legend-swatch"></span>Восприимчивый</span><span class="legend-item"><span class="legend-swatch coral"></span>Рефрактерный</span></div><span id="graph-hint" class="canvas-hint">Выберите нейрон · перетащите для перемещения</span></div></div>
          <div id="matrix-content" class="matrix-wrap is-hidden" role="tabpanel" aria-labelledby="tab-matrix"><p class="matrix-caption">Строка — источник, столбец — получатель. Изменения применяются к начальной конфигурации.</p><div id="matrix-table"></div></div>
        </section>
        <section class="panel chart-panel">
          <div class="panel-heading"><div class="tabs" role="tablist" aria-label="Графики динамики"><button id="tab-spikes" class="tab active" role="tab" aria-selected="true">Спайки</button><button id="tab-potential" class="tab" role="tab" aria-selected="false">Потенциал</button><button id="tab-difference" class="tab" role="tab" aria-selected="false">Разность времён</button></div><span id="chart-count" class="chip">0 спайков</span></div>
          <div class="chart-area"><svg id="chart" class="chart-svg" viewBox="0 0 700 180" preserveAspectRatio="none" role="img" aria-label="График динамики сети"></svg><div id="chart-empty" class="chart-empty"><strong>Здесь появится динамика сети</strong><span>Запустите эксперимент или сделайте один шаг</span></div><div id="phase" class="phase-content is-hidden"></div></div>
          <div class="chart-caption"><span id="chart-caption">Каждая отметка — спайк нейрона.</span><span id="chart-range">Время →</span></div>
        </section>
      </div>
      <aside class="right-column"><div class="panel right-panel">
        <section class="section"><div class="section-heading"><div class="selected-number"><span id="selected-dot" class="neuron-indicator"></span><span id="selected-title">Нейрон 1</span></div><button id="delete-neuron" class="button-quiet button-danger" title="Удалить выбранный нейрон" aria-label="Удалить выбранный нейрон" data-config-edit>×</button></div>
          <div id="selected-content"></div>
        </section>
        <section class="section"><div class="section-heading"><h2>Направленные связи</h2><span id="connection-count" class="connection-count"></span></div><div id="connection-list" class="connection-list"></div>
          <form id="connection-form"><div class="connection-form"><select id="connection-source" aria-label="Источник связи" data-config-edit></select><span class="connection-arrow">→</span><select id="connection-target" aria-label="Получатель связи" data-config-edit></select></div><div class="connection-add-row"><input id="connection-weight" type="number" value="1" min="0" step="any" aria-label="Вес новой связи" data-config-edit /><button id="connection-add" type="submit" data-config-edit>Добавить</button></div></form>
          <p class="help">Веса неотрицательны. Активный вход сохраняется до выхода получателя из рефрактерности.</p>
        </section>
      </div><div class="aside-footer">Состояние сети рассчитывается в браузере. Конфигурации и снимки сохраняются в файл; сервер не нужен.</div></aside>
    </main>
    <footer class="footer"><span>МОНЭ · исследовательский симулятор</span><span class="mono" id="model-version">mone-v1 · f64 · event-driven</span></footer>
  </div>`;

function setError(message: string): void {
  errorMessage = message;
  el('error-text').textContent = message;
  el('error').classList.toggle('is-hidden', !message);
  updateControls();
}

function updateControls(): void {
  document.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('[data-config-edit]').forEach((element) => { element.disabled = busy || running; });
  document.querySelectorAll<HTMLButtonElement>('[data-needs-ready]').forEach((element) => { element.disabled = busy || running || dirty || !result; });
  el<HTMLButtonElement>('run').disabled = !running && (busy || dirty || !result || result.halted);
  el('run').innerHTML = running ? `${icons.pause} Пауза` : `${icons.play} Запустить`;
  el<HTMLButtonElement>('step').disabled ||= result?.halted ?? true;
  el<HTMLButtonElement>('batch-100').disabled ||= result?.halted ?? true;
  el<HTMLButtonElement>('batch-1000').disabled ||= result?.halted ?? true;
  el<HTMLButtonElement>('add-neuron').disabled ||= config.neurons.length >= MAX_NEURONS;
  el<HTMLButtonElement>('delete-neuron').disabled ||= config.neurons.length <= 1;
  el('apply').classList.toggle('is-hidden', !dirty);
  const status = dirty ? 'Есть изменения · примените их' : running ? 'Эксперимент идёт' : busy ? 'Вычисление…' : errorMessage ? 'Проверьте конфигурацию' : result?.halted ? 'Нет будущих событий' : result ? 'Готов к запуску' : 'Загрузка ядра…';
  el('status-text').textContent = status;
  el('status').className = `state-strip ${dirty ? 'status-dirty' : running ? 'status-running' : errorMessage ? 'status-error' : ''}`;
}

function recordSample(snapshot: Snapshot): void {
  samples.push({ time: snapshot.time, values: Object.fromEntries(snapshot.neurons.map((neuron) => [neuron.id, neuron.potential])) });
  if (samples.length > MAX_HISTORY) samples.splice(0, samples.length - MAX_HISTORY);
}

function clearHistory(): void {
  events = [];
  samples = [];
  totalSpikes = 0;
  omittedEvents = 0;
  spikeOrdinals.clear();
  epochTime = dirty ? 0 : result?.snapshot.time ?? 0;
  if (result && !dirty) recordSample(result.snapshot);
}

function pause(): void { running = false; operation++; updateControls(); }

async function initialize(nextConfig = config): Promise<void> {
  if (busy) return;
  pause();
  busy = true;
  setError('');
  updateControls();
  try {
    const next = await engine.initialize(clone(nextConfig));
    config = clone(next.snapshot.config);
    result = next;
    dirty = false;
    clearHistory();
    ensureSelection();
    renderAll();
  } catch (error) {
    dirty = true;
    setError(error instanceof Error ? error.message : String(error));
  } finally { busy = false; updateControls(); }
}

async function takeStep(count: number): Promise<boolean> {
  if (busy || dirty || !result || result.halted) return false;
  busy = true;
  updateControls();
  try {
    result = await engine.step(count);
    let groupIndex = result.snapshot.eventCount - result.events.length;
    for (const event of result.events) {
      const ordinals = Object.fromEntries(event.spikes.map((id) => {
        const next = (spikeOrdinals.get(id) ?? 0) + 1;
        spikeOrdinals.set(id, next);
        return [id, next];
      }));
      events.push({ ...event, ordinals, groupIndex: ++groupIndex });
    }
    totalSpikes += result.events.reduce((sum, event) => sum + event.spikes.length, 0);
    if (events.length > MAX_HISTORY) {
      omittedEvents += events.length - MAX_HISTORY;
      events.splice(0, events.length - MAX_HISTORY);
    }
    recordSample(result.snapshot);
    renderRuntime();
    if (result.halted) running = false;
    return !result.halted;
  } catch (error) {
    running = false;
    setError(error instanceof Error ? error.message : String(error));
    return false;
  } finally { busy = false; updateControls(); }
}

async function run(limit = Infinity): Promise<void> {
  if (running) { pause(); return; }
  if (busy || dirty || !result || result.halted) return;
  running = true;
  setError('');
  const token = ++operation;
  updateControls();
  let remaining = limit;
  while (running && operation === token && remaining > 0) {
    const count = limit === Infinity ? 1 : Math.min(25, remaining);
    const continued = await takeStep(count);
    remaining -= count;
    if (!continued || operation !== token) break;
    await new Promise((resolve) => setTimeout(resolve, limit === Infinity ? 45 : 0));
  }
  if (operation === token) { running = false; updateControls(); }
}

function markDirty(): void {
  pause();
  dirty = true;
  config.model = config.neurons.some((neuron) => (neuron.initialDrive ?? 0) > 0) ? 'mone-initial-drive-v1' : 'mone-v1';
  clearHistory();
  el<HTMLSelectElement>('preset').value = 'custom';
  el('preset-description').textContent = 'Ваша конфигурация. Примените изменения, чтобы начать новый эксперимент.';
  setError('');
  renderRuntime();
  renderConnections();
  renderMatrix();
  updateControls();
}

function ensureSelection(): void {
  if (!config.neurons.some((neuron) => neuron.id === selected)) selected = config.neurons[0]?.id ?? '';
  if (!config.neurons.some((neuron) => neuron.id === pair.source)) pair.source = selected;
  if (!config.neurons.some((neuron) => neuron.id === pair.target)) pair.target = config.neurons[1]?.id ?? selected;
  config.neurons.forEach((neuron, index) => {
    if (!positions.has(neuron.id)) {
      if (config.neurons.length > 16) {
        const columns = Math.ceil(Math.sqrt(config.neurons.length * 1.6));
        const rows = Math.ceil(config.neurons.length / columns);
        positions.set(neuron.id, { x: 48 + index % columns * 604 / (columns - 1), y: 45 + Math.floor(index / columns) * 310 / Math.max(1, rows - 1) });
      } else {
        const angle = -Math.PI / 2 + index * 2 * Math.PI / config.neurons.length;
        const radius = config.neurons.length === 1 ? 0 : 145;
        positions.set(neuron.id, { x: 350 + radius * 1.25 * Math.cos(angle), y: 203 + radius * Math.sin(angle) });
      }
    }
  });
}

function renderParameters(): void {
  for (const key of ['threshold', 'rest', 'alpha', 'refractoryPeriod'] as const) el<HTMLInputElement>(key).value = String(config.parameters[key]);
}

function renderAll(): void {
  renderParameters();
  renderRuntime();
  renderConnections();
  renderMatrix();
  updateControls();
}

function renderRuntime(): void {
  const snapshot = dirty ? null : result?.snapshot;
  el('time-value').textContent = snapshot ? snapshot.time.toFixed(3) : '0.000';
  el('event-value').textContent = number(snapshot?.eventCount ?? 0, 0);
  el('network-value').textContent = `${config.neurons.length} / ${config.connections.length}`;
  const { rest, threshold } = config.parameters;
  el('model-note').textContent = rest > threshold ? 'r > p · нейроны могут генерировать спайки самостоятельно.' : rest < threshold ? 'r < p · для спайка нужен достаточный входной сигнал.' : 'r = p · без входов порог достигается только асимптотически.';
  el('model-version').textContent = `${config.model} · f64 · event-driven`;
  renderGraph();
  renderSelected();
  renderChart();
}

function renderGraph(): void {
  ensureSelection();
  const snapshot = dirty ? null : result?.snapshot;
  const states = new Map(snapshot?.neurons.map((neuron) => [neuron.id, neuron]));
  const indexes = new Map(config.neurons.map((neuron, index) => [neuron.id, index]));
  const reverse = new Set(config.connections.map((connection) => edgeKey(connection.source, connection.target)));
  const many = config.neurons.length > 24;
  const radius = many ? 17 : 26;
  let svg = `<defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 1 L 9 5 L 0 9 z" fill="#b2c4b9"/></marker><marker id="arrow-active" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 1 L 9 5 L 0 9 z" fill="#73b29c"/></marker></defs>`;
  const visibleConnections = config.connections.length > 200 ? config.connections.filter((connection) => connection.source === selected || connection.target === selected) : config.connections;
  el('graph-scope').classList.toggle('is-hidden', config.connections.length <= 200);
  el('graph-hint').textContent = config.connections.length > 200 ? 'Показаны связи выбранного нейрона' : 'Выберите нейрон · перетащите для перемещения';
  for (const connection of visibleConnections) {
    const start = positions.get(connection.source);
    const end = positions.get(connection.target);
    if (!start || !end) continue;
    const dx = end.x - start.x, dy = end.y - start.y, length = Math.hypot(dx, dy) || 1;
    const ux = dx / length, uy = dy / length;
    const offset = reverse.has(edgeKey(connection.target, connection.source)) ? 11 : 0;
    const x1 = start.x + ux * (radius + 5) - uy * offset, y1 = start.y + uy * (radius + 5) + ux * offset;
    const x2 = end.x - ux * (radius + 7) - uy * offset, y2 = end.y - uy * (radius + 7) + ux * offset;
    const active = snapshot?.activeInputs[indexes.get(connection.source)!]?.[indexes.get(connection.target)!] ?? false;
    svg += `<path class="edge-line${active ? ' active-input' : ''}" d="M${x1},${y1} L${x2},${y2}" marker-end="url(#${active ? 'arrow-active' : 'arrow'})"/>`;
    if (config.connections.length <= 30) svg += `<text class="edge-label" x="${(x1 + x2) / 2 - uy * 9}" y="${(y1 + y2) / 2 + ux * 9}" text-anchor="middle">${escape(compact(connection.weight))}</text>`;
  }
  for (const initial of config.neurons) {
    const neuron = states.get(initial.id) ?? initial;
    const pos = positions.get(initial.id)!;
    svg += `<g class="node ${neuron.state}${selected === initial.id ? ' selected' : ''}" data-neuron="${escape(initial.id)}" transform="translate(${pos.x},${pos.y})" role="button" tabindex="0" aria-label="Нейрон ${escape(initial.id)}, потенциал ${escape(number(neuron.potential))}"><circle class="node-ring" r="${radius + 8}"/><circle class="node-circle" r="${radius}"/><text class="node-id" y="${many ? 5 : -1}" style="font-size:${many ? 10 : 15}px">${escape(shortId(initial.id))}</text>${many ? '' : `<text class="node-potential" y="15">${escape(compact(neuron.potential))}</text>`}</g>`;
  }
  el('topology').innerHTML = svg;
}

function renderSelected(): void {
  const initial = config.neurons.find((neuron) => neuron.id === selected);
  if (!initial) { el('selected-content').innerHTML = '<div class="empty-panel">Добавьте нейрон, чтобы настроить его состояние.</div>'; return; }
  const state = (dirty ? null : result?.snapshot.neurons.find((neuron) => neuron.id === selected)) ?? { ...initial, nextEventIn: null };
  el('selected-title').textContent = `Нейрон ${shortId(selected)}`;
  el('selected-title').title = selected;
  el('selected-dot').className = `neuron-indicator ${state.state}`;
  el('selected-content').innerHTML = `
    <div class="state-card"><div class="state-card-top"><span>${dirty ? 'Начальный потенциал' : 'Текущий потенциал'}</span><span>${state.state === 'refractory' ? 'Рефрактерный' : 'Восприимчивый'}</span></div><div class="state-card-value ${state.state}">${escape(number(state.potential, 5))}</div><div class="state-card-bottom">${dirty ? 'Изменения ещё не применены' : `До события: ${state.nextEventIn === null ? '∞' : number(state.nextEventIn, 5)}`}</div></div>
    <div class="subheading">Начальные условия</div>
    <label class="field"><span class="field-label">Идентификатор нейрона</span><input id="neuron-id" type="text" value="${escape(initial.id)}" aria-label="Идентификатор выбранного нейрона" data-config-edit /></label>
    <div class="field-grid"><label class="field"><span class="field-label">Потенциал <span class="symbol">u₀</span></span><input id="neuron-potential" type="number" step="any" value="${escape(initial.potential)}" aria-label="Начальный потенциал выбранного нейрона" data-config-edit /></label><label class="field"><span class="field-label">Состояние</span><select id="neuron-state" aria-label="Начальное состояние выбранного нейрона" data-config-edit><option value="receptive" ${initial.state === 'receptive' ? 'selected' : ''}>Восприимч.</option><option value="refractory" ${initial.state === 'refractory' ? 'selected' : ''}>Рефракт.</option></select></label></div>
    <label class="field"><span class="field-label">Начальный ток до первого спайка <span class="symbol">Q</span></span><input id="neuron-drive" type="number" min="0" step="any" value="${escape(initial.initialDrive ?? 0)}" aria-label="Начальный ток до первого спайка" data-config-edit /></label>
    ${initial.initialDrive ? '<p class="help">Ненулевой Q включает расширение модели с начальным током.</p>' : ''}`;
  el<HTMLInputElement>('neuron-id').addEventListener('change', (event) => {
    const id = (event.currentTarget as HTMLInputElement).value.trim();
    if (!id || new TextEncoder().encode(id).length > 128) { setError('Идентификатор должен быть непустым и не длиннее 128 байт UTF-8.'); return; }
    if (config.neurons.some((neuron) => neuron.id === id && neuron !== initial)) { setError('Нейрон с таким идентификатором уже существует.'); return; }
    const previous = initial.id;
    if (id === previous) return;
    initial.id = id;
    for (const connection of config.connections) {
      if (connection.source === previous) connection.source = id;
      if (connection.target === previous) connection.target = id;
    }
    if (positions.has(previous)) { positions.set(id, positions.get(previous)!); positions.delete(previous); }
    if (pair.source === previous) pair.source = id;
    if (pair.target === previous) pair.target = id;
    selected = id;
    markDirty();
  });
  el<HTMLInputElement>('neuron-potential').addEventListener('change', (event) => {
    const input = event.currentTarget as HTMLInputElement;
    if (!validNumber(input)) return;
    initial.potential = Number(input.value);
    markDirty();
  });
  el<HTMLSelectElement>('neuron-state').addEventListener('change', (event) => {
    initial.state = (event.currentTarget as HTMLSelectElement).value as 'receptive' | 'refractory';
    initial.potential = initial.state === 'refractory' ? -1 : 0;
    markDirty();
  });
  el<HTMLInputElement>('neuron-drive').addEventListener('change', (event) => {
    const input = event.currentTarget as HTMLInputElement;
    if (!validNumber(input) || Number(input.value) < 0) { setError('Начальный ток должен быть конечным неотрицательным числом.'); return; }
    initial.initialDrive = Number(input.value);
    markDirty();
  });
  updateControls();
}

function renderConnections(): void {
  const related = config.connections.filter((connection) => connection.source === selected || connection.target === selected);
  el('connection-count').textContent = String(related.length);
  el('connection-list').innerHTML = related.length ? related.map((connection) => {
    const index = config.connections.indexOf(connection);
    return `<div class="connection-item"><span class="connection-name" title="${escape(connection.source)} → ${escape(connection.target)}">${escape(shortId(connection.source))} → ${escape(shortId(connection.target))}</span><input type="number" min="0" step="any" value="${escape(connection.weight)}" data-connection="${index}" aria-label="Вес связи ${escape(connection.source)} → ${escape(connection.target)}" data-config-edit /><button data-delete-connection="${index}" aria-label="Удалить связь ${escape(connection.source)} → ${escape(connection.target)}" data-config-edit>×</button></div>`;
  }).join('') : '<div class="connection-empty">У выбранного нейрона пока нет связей.</div>';
  const source = el<HTMLSelectElement>('connection-source'), target = el<HTMLSelectElement>('connection-target');
  const previousSource = source.value, previousTarget = target.value;
  const options = config.neurons.map((neuron) => `<option value="${escape(neuron.id)}">${escape(neuron.id)}</option>`).join('');
  source.innerHTML = options;
  target.innerHTML = options;
  source.value = config.neurons.some((neuron) => neuron.id === previousSource) ? previousSource : selected;
  target.value = config.neurons.some((neuron) => neuron.id === previousTarget) ? previousTarget : config.neurons.find((neuron) => neuron.id !== source.value)?.id ?? source.value;
  updateControls();
}

function renderMatrix(): void {
  if (graphTab !== 'matrix') return;
  const weights = new Map(config.connections.map((connection) => [edgeKey(connection.source, connection.target), connection.weight]));
  el('matrix-table').innerHTML = `<table class="matrix"><thead><tr><th>из ↓ в →</th>${config.neurons.map((neuron) => `<th scope="col">${escape(shortId(neuron.id))}</th>`).join('')}</tr></thead><tbody>${config.neurons.map((source) => `<tr><th scope="row">${escape(shortId(source.id))}</th>${config.neurons.map((target) => source.id === target.id ? '<td class="matrix-zero">—</td>' : `<td><input type="number" min="0" step="any" value="${weights.get(edgeKey(source.id, target.id)) ?? 0}" data-matrix-source="${escape(source.id)}" data-matrix-target="${escape(target.id)}" aria-label="Вес ${escape(source.id)} → ${escape(target.id)}" data-config-edit /></td>`).join('')}</tr>`).join('')}</tbody></table>`;
  updateControls();
}

function renderChart(): void {
  renderCharts({ config, snapshot: dirty ? null : result?.snapshot ?? null, selected, events, samples, tab: chartTab, pair, totalSpikes, omittedEvents, epochTime }, (nextPair) => {
    pair = nextPair;
    renderChart();
  });
}

function validNumber(input: HTMLInputElement): boolean {
  if (input.value.trim() && Number.isFinite(Number(input.value))) return true;
  setError('Введите конечное число. Пустые значения не применяются.');
  return false;
}

function setWeight(source: string, target: string, weight: number): void {
  if (!Number.isFinite(weight) || weight < 0) { setError('Вес связи должен быть конечным неотрицательным числом.'); return; }
  if (source === target) { setError('В исходной модели связи нейрона с самим собой не используются.'); return; }
  const connection = config.connections.find((item) => item.source === source && item.target === target);
  if (connection) connection.weight = weight;
  else config.connections.push({ source, target, weight });
  markDirty();
}

function download(name: string, data: string, type: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  closeExport();
}

function closeExport(): void {
  el('export-options').classList.add('is-hidden');
  el('export-toggle').setAttribute('aria-expanded', 'false');
}

function checkImportedConfig(value: unknown): asserts value is Config {
  if (!value || typeof value !== 'object' || !('neurons' in value) || !Array.isArray(value.neurons) || !('connections' in value) || !Array.isArray(value.connections)) throw new Error('В файле нет конфигурации сети. Выберите JSON конфигурации или снимка.');
  if (value.neurons.length < 1 || value.neurons.length > MAX_NEURONS) throw new Error(`Интерфейс поддерживает от 1 до ${MAX_NEURONS} нейронов.`);
}

async function importFile(file: File): Promise<void> {
  if (busy || running) return;
  busy = true;
  setError('');
  updateControls();
  try {
    if (file.size > 10 * 1024 * 1024) throw new Error('Файл больше 10 МБ. Выберите меньшую конфигурацию или снимок.');
    const parsed: unknown = JSON.parse(await file.text());
    const isSnapshot = !!parsed && typeof parsed === 'object' && 'config' in parsed && 'activeInputs' in parsed;
    const candidate = isSnapshot ? (parsed as Snapshot).config : parsed;
    checkImportedConfig(candidate);
    const restored = isSnapshot ? await engine.restore(parsed as Snapshot) : await engine.initialize(candidate);
    config = clone(restored.snapshot.config);
    result = restored;
    dirty = false;
    positions.clear();
    ensureSelection();
    clearHistory();
    el<HTMLSelectElement>('preset').value = 'custom';
    el('preset-description').textContent = `${isSnapshot ? 'Снимок состояния' : 'Конфигурация'}: ${file.name}. ${isSnapshot ? 'Расчёт продолжится с сохранённого времени; старой истории графиков в снимке нет.' : 'Начальные условия загружены.'}`;
    renderAll();
  } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  finally { busy = false; el<HTMLInputElement>('import-file').value = ''; updateControls(); }
}

el('run').addEventListener('click', () => { void run(); });
el('step').addEventListener('click', () => { void takeStep(1); });
el('batch-100').addEventListener('click', () => { void run(100); });
el('batch-1000').addEventListener('click', () => { void run(1000); });
el('reset').addEventListener('click', () => { void initialize(); });
el('apply').addEventListener('click', () => { void initialize(); });
el('dismiss-error').addEventListener('click', () => setError(''));
el('clear-charts').addEventListener('click', () => { clearHistory(); renderChart(); });
el<HTMLSelectElement>('preset').addEventListener('change', async (event) => {
  const preset = PRESETS.find((item) => item.id === (event.currentTarget as HTMLSelectElement).value);
  if (!preset) return;
  config = clone(preset.config);
  dirty = true;
  positions.clear();
  ensureSelection();
  renderAll();
  el('preset-description').textContent = preset.description;
  await initialize();
});
for (const key of ['threshold', 'rest', 'alpha', 'refractoryPeriod'] as const) el<HTMLInputElement>(key).addEventListener('change', (event) => {
  const input = event.currentTarget as HTMLInputElement;
  if (!validNumber(input)) return;
  config.parameters[key] = Number(input.value);
  markDirty();
});

el('add-neuron').addEventListener('click', () => {
  if (config.neurons.length >= MAX_NEURONS) return;
  let index = config.neurons.length + 1;
  while (config.neurons.some((neuron) => neuron.id === String(index))) index++;
  selected = String(index);
  config.neurons.push({ id: selected, potential: 0, state: 'receptive' });
  positions.clear();
  ensureSelection();
  markDirty();
});
el('delete-neuron').addEventListener('click', () => {
  if (config.neurons.length <= 1) return;
  config.neurons = config.neurons.filter((neuron) => neuron.id !== selected);
  config.connections = config.connections.filter((connection) => connection.source !== selected && connection.target !== selected);
  positions.delete(selected);
  ensureSelection();
  markDirty();
});
el('fully-connect').addEventListener('click', () => {
  const existing = new Set(config.connections.map((connection) => edgeKey(connection.source, connection.target)));
  for (const source of config.neurons) for (const target of config.neurons) {
    if (source.id !== target.id && !existing.has(edgeKey(source.id, target.id))) config.connections.push({ source: source.id, target: target.id, weight: 1 });
  }
  markDirty();
});
el('connection-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = el<HTMLInputElement>('connection-weight');
  if (!validNumber(input)) return;
  setWeight(el<HTMLSelectElement>('connection-source').value, el<HTMLSelectElement>('connection-target').value, Number(input.value));
});
el('connection-list').addEventListener('change', (event) => {
  const input = event.target as HTMLInputElement;
  if (input.dataset.connection === undefined || !validNumber(input)) return;
  const connection = config.connections[Number(input.dataset.connection)];
  if (connection) setWeight(connection.source, connection.target, Number(input.value));
});
el('connection-list').addEventListener('click', (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>('[data-delete-connection]');
  if (!button) return;
  config.connections.splice(Number(button.dataset.deleteConnection), 1);
  markDirty();
});
el('matrix-table').addEventListener('change', (event) => {
  const input = event.target as HTMLInputElement;
  if (!input.dataset.matrixSource || !input.dataset.matrixTarget || !validNumber(input)) return;
  setWeight(input.dataset.matrixSource, input.dataset.matrixTarget, Number(input.value));
});
for (const tab of ['graph', 'matrix'] as const) el(`tab-${tab}`).addEventListener('click', () => {
  graphTab = tab;
  for (const item of ['graph', 'matrix']) {
    el(`tab-${item}`).classList.toggle('active', item === tab);
    el(`tab-${item}`).setAttribute('aria-selected', String(item === tab));
    el(`${item}-content`).classList.toggle('is-hidden', item !== tab);
  }
  renderMatrix();
});
for (const tab of ['spikes', 'potential', 'difference'] as const) el(`tab-${tab}`).addEventListener('click', () => {
  chartTab = tab;
  for (const item of ['spikes', 'potential', 'difference']) {
    el(`tab-${item}`).classList.toggle('active', item === tab);
    el(`tab-${item}`).setAttribute('aria-selected', String(item === tab));
  }
  renderChart();
});

const topology = document.getElementById('topology') as unknown as SVGSVGElement;
let drag: { id: string; pointerId: number } | null = null;
topology.addEventListener('pointerdown', (event) => {
  const node = (event.target as Element).closest<SVGGElement>('[data-neuron]');
  if (!node?.dataset.neuron) return;
  selected = node.dataset.neuron;
  drag = { id: selected, pointerId: event.pointerId };
  topology.setPointerCapture(event.pointerId);
  renderSelected();
  renderConnections();
  renderGraph();
  renderChart();
});
topology.addEventListener('pointermove', (event) => {
  if (!drag || drag.pointerId !== event.pointerId) return;
  const matrix = topology.getScreenCTM();
  if (!matrix) return;
  const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
  positions.set(drag.id, { x: Math.max(40, Math.min(660, point.x)), y: Math.max(40, Math.min(363, point.y)) });
  renderGraph();
});
topology.addEventListener('pointerup', () => { drag = null; });
topology.addEventListener('pointercancel', () => { drag = null; });
topology.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const node = (event.target as Element).closest<SVGGElement>('[data-neuron]');
  if (!node?.dataset.neuron) return;
  event.preventDefault();
  selected = node.dataset.neuron;
  renderRuntime();
  renderConnections();
});
el('import').addEventListener('click', () => el<HTMLInputElement>('import-file').click());
el<HTMLInputElement>('import-file').addEventListener('change', (event) => {
  const file = (event.currentTarget as HTMLInputElement).files?.[0];
  if (file) void importFile(file);
});
el('export-toggle').addEventListener('click', () => {
  const closed = el('export-options').classList.toggle('is-hidden');
  el('export-toggle').setAttribute('aria-expanded', String(!closed));
});
document.addEventListener('click', (event) => { if (!(event.target as Element).closest('.export-menu')) closeExport(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { closeExport(); if (running) pause(); } });
el('export-config').addEventListener('click', () => download('mone-config.json', JSON.stringify(config, null, 2), 'application/json'));
el('export-snapshot').addEventListener('click', () => { if (result && !dirty) download('mone-snapshot.json', JSON.stringify(result.snapshot, null, 2), 'application/json'); });
el('export-events').addEventListener('click', () => {
  const csvCell = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const rows = events.flatMap((event) => [
    ...event.spikes.map((id) => `${event.time},${event.delta},${event.groupIndex},spike,${csvCell(id)},${event.ordinals[id]}`),
    ...event.recovered.map((id) => `${event.time},${event.delta},${event.groupIndex},recovery,${csvCell(id)},`),
  ]);
  download('mone-events-window.csv', `time,delta,group_index,event,neuron,spike_index\n${rows.join('\n')}\n`, 'text/csv;charset=utf-8');
});
window.addEventListener('beforeunload', () => engine.dispose());
let chartWidth = 0;
new ResizeObserver((entries) => {
  const width = entries[0]?.contentRect.width ?? 0;
  if (Math.abs(width - chartWidth) < 1) return;
  chartWidth = width;
  renderChart();
}).observe(el('chart').parentElement!);
ensureSelection();
renderAll();
void initialize();
