import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import type { CompletedRun } from '../types';

const STORAGE_KEY = 'ultra-coach.runs.v1';
const MAX_RUNS = 200;

interface RunsStore {
  runs: CompletedRun[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  save: (run: CompletedRun) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export const useRuns = create<RunsStore>((set, get) => ({
  runs: [],
  hydrated: false,
  hydrate: async () => {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    set({ runs: raw ? (JSON.parse(raw) as CompletedRun[]) : [], hydrated: true });
  },
  save: async (run) => {
    const runs = [run, ...get().runs].slice(0, MAX_RUNS);
    set({ runs });
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(runs));
  },
  remove: async (id) => {
    const runs = get().runs.filter((run) => run.id !== id);
    set({ runs });
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(runs));
  },
}));
