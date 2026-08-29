import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { create } from 'zustand';
import { DEFAULT_COACH_CONFIG, type CoachConfig } from '../coach/engine';
import { DEFAULT_PLAN_CONFIG, generatePlan, type PlanConfig } from '../coach/plan';
import { DEFAULT_ZONES } from '../metrics';
import type { HeartRateZones, TrainingPlan } from '../types';
import { DEFAULT_MODEL_ID, DEFAULT_VOICE_ID } from '../voice/elevenlabs';

const STORAGE_KEY = 'ultra-coach.settings.v1';
const API_KEY_ENTRY = 'elevenlabs_api_key';

export interface Settings {
  zones: HeartRateZones;
  coach: CoachConfig;
  voiceId: string;
  modelId: string;
  agentId: string;
  useSimulators: boolean;
  preferredDeviceId: string | null;
  allowLiveSynthesis: boolean;
  allowDeviceFallback: boolean;
  volume: number;
  planConfig: PlanConfig;
  planStartDateIso: string;
  plan: TrainingPlan | null;
}

export const DEFAULT_SETTINGS: Settings = {
  zones: DEFAULT_ZONES,
  coach: DEFAULT_COACH_CONFIG,
  voiceId: DEFAULT_VOICE_ID,
  modelId: DEFAULT_MODEL_ID,
  agentId: '',
  useSimulators: false,
  preferredDeviceId: null,
  allowLiveSynthesis: true,
  allowDeviceFallback: true,
  volume: 1,
  planConfig: DEFAULT_PLAN_CONFIG,
  planStartDateIso: DEFAULT_PLAN_CONFIG.startDateIso,
  plan: null,
};

interface SettingsStore {
  settings: Settings;
  apiKey: string;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  update: (patch: Partial<Settings>) => Promise<void>;
  setApiKey: (key: string) => Promise<void>;
  regeneratePlan: (config: PlanConfig) => Promise<void>;
}

async function persist(settings: Settings): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

export const useSettings = create<SettingsStore>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  apiKey: '',
  hydrated: false,
  hydrate: async () => {
    const [raw, key] = await Promise.all([
      AsyncStorage.getItem(STORAGE_KEY),
      SecureStore.getItemAsync(API_KEY_ENTRY).catch(() => null),
    ]);
    const stored = raw ? (JSON.parse(raw) as Partial<Settings>) : {};
    set({
      settings: {
        ...DEFAULT_SETTINGS,
        ...stored,
        zones: { ...DEFAULT_ZONES, ...stored.zones },
        coach: { ...DEFAULT_COACH_CONFIG, ...stored.coach },
        planConfig: { ...DEFAULT_PLAN_CONFIG, ...stored.planConfig },
      },
      apiKey: key ?? '',
      hydrated: true,
    });
  },
  update: async (patch) => {
    const settings = { ...get().settings, ...patch };
    set({ settings });
    await persist(settings);
  },
  setApiKey: async (key) => {
    set({ apiKey: key });
    if (key) await SecureStore.setItemAsync(API_KEY_ENTRY, key);
    else await SecureStore.deleteItemAsync(API_KEY_ENTRY).catch(() => undefined);
  },
  regeneratePlan: async (config) => {
    const plan = generatePlan(config);
    const settings = {
      ...get().settings,
      planConfig: config,
      planStartDateIso: config.startDateIso,
      plan,
    };
    set({ settings });
    await persist(settings);
  },
}));

export function voiceConfigFrom(settings: Settings, apiKey: string) {
  if (!apiKey) return null;
  return { apiKey, voiceId: settings.voiceId, modelId: settings.modelId };
}
