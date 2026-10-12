export type NeuronState = 'receptive' | 'refractory';
export interface Config {
  schemaVersion: 1;
  model: 'mone-v1' | 'mone-initial-drive-v1';
  parameters: { threshold: number; rest: number; alpha: number; refractoryPeriod: number };
  neurons: { id: string; potential: number; state: NeuronState; initialDrive?: number }[];
  connections: { source: string; target: string; weight: number }[];
}
export interface Snapshot {
  schemaVersion: 1;
  config: Config;
  time: number;
  timeCorrection: number;
  eventCount: number;
  neurons: { id: string; potential: number; state: NeuronState; drive: number; nextEventIn: number | null }[];
  activeInputs: boolean[][];
}
export interface NetworkEvent { time: number; delta: number; spikes: string[]; recovered: string[] }
export interface RunResult { snapshot: Snapshot; events: NetworkEvent[]; halted: boolean }

export type EngineRequest =
  | { id: number; operation: 'initialize'; config: Config }
  | { id: number; operation: 'restore'; snapshot: Snapshot }
  | { id: number; operation: 'step'; count: number };
export type EngineResponse = { id: number; result: RunResult } | { id: number; error: string };
