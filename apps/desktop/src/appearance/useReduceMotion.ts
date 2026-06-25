import { useEffect, useSyncExternalStore } from 'react';
import { useSettings } from '../settings/SettingsContext';
import {
  applyReduceMotion,
  resolveReduceMotion,
  subscribeSystemReduce,
  systemPrefersReduce,
} from './motion';

/** The one hook every animated surface uses. Live-tracks BOTH the OS prefers-reduced-motion
    signal and the user's Animations setting, writes <html data-reduce-motion> for the CSS
    gates, and returns the resolved boolean for JS gates. Replaces motion/react's
    useReducedMotion and the per-component matchMedia readers so there is a single definition. */
export function useReduceMotion(): boolean {
  const { motion } = useSettings();
  const systemReduce = useSyncExternalStore(subscribeSystemReduce, systemPrefersReduce, () => false);
  const reduce = resolveReduceMotion(motion, systemReduce);
  useEffect(() => {
    applyReduceMotion(reduce);
  }, [reduce]);
  return reduce;
}
