const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function base64ToBytes(input: string): Uint8Array {
  const clean = input.replace(/[^A-Za-z0-9+/]/g, '');
  const output = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let outIndex = 0;
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const value = BASE64_ALPHABET.indexOf(char);
    if (value < 0) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output[outIndex] = (buffer >> bits) & 0xff;
      outIndex += 1;
    }
  }
  return output.subarray(0, outIndex);
}

export interface HeartRateMeasurement {
  bpm: number;
  contactDetected?: boolean;
  energyExpendedKj?: number;
  rrIntervalsMs?: number[];
}

/**
 * Parses the Bluetooth SIG Heart Rate Measurement characteristic (0x2A37).
 * Flags byte: bit0 value format, bits1-2 sensor contact, bit3 energy expended,
 * bit4 RR intervals.
 */
export function parseHeartRateMeasurement(bytes: Uint8Array): HeartRateMeasurement | null {
  if (bytes.length < 2) return null;
  const flags = bytes[0];
  const is16Bit = (flags & 0x01) !== 0;
  let offset = 1;
  let bpm: number;
  if (is16Bit) {
    if (bytes.length < 3) return null;
    bpm = bytes[1] | (bytes[2] << 8);
    offset = 3;
  } else {
    bpm = bytes[1];
    offset = 2;
  }

  const measurement: HeartRateMeasurement = { bpm };

  const contactSupported = (flags & 0x04) !== 0;
  if (contactSupported) measurement.contactDetected = (flags & 0x02) !== 0;

  if ((flags & 0x08) !== 0 && bytes.length >= offset + 2) {
    measurement.energyExpendedKj = bytes[offset] | (bytes[offset + 1] << 8);
    offset += 2;
  }

  if ((flags & 0x10) !== 0) {
    const rrIntervalsMs: number[] = [];
    while (offset + 1 < bytes.length) {
      const raw = bytes[offset] | (bytes[offset + 1] << 8);
      rrIntervalsMs.push((raw / 1024) * 1000);
      offset += 2;
    }
    if (rrIntervalsMs.length > 0) measurement.rrIntervalsMs = rrIntervalsMs;
  }

  return measurement;
}

export function parseHeartRateBase64(value: string): HeartRateMeasurement | null {
  return parseHeartRateMeasurement(base64ToBytes(value));
}
