import { parseHeartRateMeasurement, type HeartRateMeasurement } from '../sensors/hrParser';

function parse(bytes: number[]): HeartRateMeasurement {
  const result = parseHeartRateMeasurement(new Uint8Array(bytes));
  if (!result) throw new Error('expected a parsed measurement');
  return result;
}

describe('parseHeartRateMeasurement', () => {
  it('rejects a truncated packet', () => {
    expect(parseHeartRateMeasurement(new Uint8Array([0x00]))).toBeNull();
  });

  it('reads an 8 bit value', () => {
    expect(parse([0x00, 142]).bpm).toBe(142);
  });

  it('reads a 16 bit value', () => {
    expect(parse([0x01, 0x2c, 0x01]).bpm).toBe(300);
  });

  it('reports sensor contact when supported', () => {
    expect(parse([0b00000110, 60]).contactDetected).toBe(true);
    expect(parse([0b00000100, 60]).contactDetected).toBe(false);
    expect(parse([0b00000000, 60]).contactDetected).toBeUndefined();
  });

  it('converts RR intervals from 1/1024 s to milliseconds', () => {
    expect(parse([0b00010000, 60, 0x00, 0x04]).rrIntervalsMs?.[0]).toBeCloseTo(1000, 0);
  });

  it('skips energy expended before RR intervals', () => {
    const result = parse([0b00011000, 60, 0x10, 0x00, 0x00, 0x04]);
    expect(result.energyExpendedKj).toBe(16);
    expect(result.rrIntervalsMs?.[0]).toBeCloseTo(1000, 0);
  });
});
