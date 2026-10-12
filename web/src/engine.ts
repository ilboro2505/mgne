import type { Config, EngineRequest, EngineResponse, RunResult, Snapshot } from './contracts';

/** The worker is the sole owner of the Rust simulation. No dynamics run in the UI. */
export class EngineClient {
  private worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  private sequence = 0;
  private disposed = false;
  private pending = new Map<number, { resolve: (value: RunResult) => void; reject: (reason: Error) => void }>();

  constructor() {
    this.worker.onmessage = ({ data }: MessageEvent<EngineResponse>) => {
      const request = this.pending.get(data.id);
      if (!request) return;
      this.pending.delete(data.id);
      if ('error' in data) request.reject(new Error(data.error));
      else request.resolve(data.result);
    };
    this.worker.onerror = (event) => {
      this.dispose(new Error(event.message || 'Не удалось загрузить вычислительное ядро.'));
    };
    this.worker.onmessageerror = () => this.dispose(new Error('Не удалось прочитать ответ ядра.'));
  }

  initialize(config: Config): Promise<RunResult> { return this.send({ operation: 'initialize', config }); }
  restore(snapshot: Snapshot): Promise<RunResult> { return this.send({ operation: 'restore', snapshot }); }
  step(count: number): Promise<RunResult> { return this.send({ operation: 'step', count }); }

  dispose(error = new Error('Вычислительный поток остановлен.')): void {
    this.disposed = true;
    this.worker.terminate();
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  private send(request: Omit<Extract<EngineRequest, { operation: 'initialize' }>, 'id'> |
    Omit<Extract<EngineRequest, { operation: 'restore' }>, 'id'> |
    Omit<Extract<EngineRequest, { operation: 'step' }>, 'id'>): Promise<RunResult> {
    if (this.disposed) return Promise.reject(new Error('Вычислительный поток недоступен. Перезагрузите страницу.'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.worker.postMessage({ ...request, id }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }
}
