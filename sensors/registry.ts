import { apt } from './channels/apt.ts';
import { ios } from './channels/ios.ts';
import { loadspot } from './channels/loadspot.ts';
import { macos } from './channels/macos.ts';
import { snap } from './channels/snap.ts';
import { store } from './channels/store.ts';
import { windows } from './channels/windows.ts';
import type { Sensor } from './types.ts';

/** Every channel sensor, in the order a full run reads them. */
export const SENSORS: readonly Sensor[] = [windows, macos, apt, snap, store, ios, loadspot];
