import init, { Simulation } from './wasm/mgne_core';
import wasmUrl from './wasm/mgne_core_bg.wasm?url';
import type { EngineRequest, EngineResponse, RunResult } from './contracts';

const ready = init({ module_or_path: wasmUrl });
let simulation: Simulation | undefined;
let queue = Promise.resolve();

// Serializing even initialization prevents an await during WASM loading from reordering commands.
self.onmessage = ({ data }: MessageEvent<EngineRequest>) => {
  queue = queue.then(async () => {
    try {
      await ready;
      let result: RunResult;
      if (data.operation === 'initialize' || data.operation === 'restore') {
        const replacement = data.operation === 'initialize'
          ? new Simulation(JSON.stringify(data.config))
          : Simulation.fromSnapshot(JSON.stringify(data.snapshot));
        const initial = JSON.parse(replacement.step(0)) as RunResult;
        simulation?.free();
        simulation = replacement;
        result = initial;
      } else {
        if (!simulation) throw new Error('Сначала создайте сеть.');
        result = JSON.parse(simulation.step(data.count)) as RunResult;
      }
      self.postMessage({ id: data.id, result } satisfies EngineResponse);
    } catch (error) {
      self.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) } satisfies EngineResponse);
    }
  });
};
