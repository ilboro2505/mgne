import ring from '../../examples/ring.json';
import refractoryRing from '../../examples/refractory-ring.json';
import detectorRing from '../../examples/detector-ring.json';
import oscillator from '../../examples/oscillator.json';
import silent from '../../examples/silent-detector.json';
import type { Config } from './contracts';

export const PRESETS: { id: string; name: string; description: string; config: Config }[] = [
  { id: 'ring', name: 'Кольцо · опыт A', description: 'Шесть автогенераторов. Начальные условия и веса опыта A из диплома.', config: ring as Config },
  { id: 'refractory-ring', name: 'Кольцо · опыт B', description: 'Шесть элементов стартуют в рефрактерности. Условия опыта B из диплома.', config: refractoryRing as Config },
  { id: 'detector-ring', name: 'Кольцо детекторов', description: 'Порог выше покоя. Начальный ток первого элемента запускает волну; после первого спайка ток отключается.', config: detectorRing as Config },
  { id: 'oscillator', name: 'Один автогенератор', description: 'Аналитический контроль: установившийся период 3 + 2 ln(20/3) ≈ 6,79424.', config: oscillator as Config },
  { id: 'silent-detector', name: 'Детектор без входа', description: 'Без внешнего воздействия порог недостижим. Внутренних событий нет.', config: silent as Config },
];
