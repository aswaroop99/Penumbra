import { useCallback, useEffect, useRef, useState } from 'react';
import { SRGBColorSpace, Texture, TextureLoader } from 'three';
import type { Manifest } from '../lib/manifest';
import { loadRawGrid, type RawGrid } from '../lib/sky';

const base = () => `${import.meta.env.BASE_URL}data/`;

export interface TextureState {
  textures: (Texture | null)[];
  loaded: number;
  total: number;
  error: string | null;
}

/** Loads every layer PNG; reports progress and failures instead of throwing. */
export function useLayerTextures(manifest: Manifest): TextureState {
  const [state, setState] = useState<TextureState>({
    textures: manifest.layers.map(() => null),
    loaded: 0,
    total: manifest.layers.length,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    const loader = new TextureLoader();
    const acquired: Texture[] = [];
    setState({
      textures: manifest.layers.map(() => null),
      loaded: 0,
      total: manifest.layers.length,
      error: null,
    });

    manifest.layers.forEach((layer, i) => {
      loader.load(
        `${base()}${encodeURIComponent(layer.png)}`,
        (tex) => {
          if (cancelled) {
            tex.dispose();
            return;
          }
          tex.colorSpace = SRGBColorSpace;
          tex.anisotropy = 8;
          tex.needsUpdate = true;
          acquired.push(tex);
          setState((s) => {
            const textures = s.textures.slice();
            textures[i] = tex;
            return { ...s, textures, loaded: s.loaded + 1 };
          });
        },
        undefined,
        () => {
          if (cancelled) return;
          setState((s) => ({ ...s, error: `Could not load ${layer.png}` }));
        }
      );
    });

    return () => {
      cancelled = true;
      acquired.forEach((t) => t.dispose());
    };
  }, [manifest]);

  return state;
}

export interface GridApi {
  /** Cached grid for a layer, or undefined while it is not (yet) loaded. */
  get: (layer: number) => RawGrid | undefined;
  /** Load (once) and resolve a layer's raw grid. Rejects if it cannot be loaded. */
  ensure: (layer: number) => Promise<RawGrid>;
  error: string | null;
}

/**
 * Lazily loads raw float16 grids (hover κ readout + masked-footprint checks).
 * `prefetch` is loaded eagerly so the active layer is ready for hovering.
 */
export function useRawGrids(manifest: Manifest, prefetch: number): GridApi {
  const cache = useRef(new Map<number, RawGrid>());
  const inflight = useRef(new Map<number, Promise<RawGrid>>());
  const [, bump] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    cache.current.clear();
    inflight.current.clear();
    bump((n) => n + 1);
  }, [manifest]);

  const ensure = useCallback(
    (layer: number): Promise<RawGrid> => {
      const hit = cache.current.get(layer);
      if (hit) return Promise.resolve(hit);
      const pending = inflight.current.get(layer);
      if (pending) return pending;
      const info = manifest.layers[layer];
      if (!info) return Promise.reject(new Error(`No layer ${layer}`));
      const p = loadRawGrid(`${base()}${encodeURIComponent(info.raw)}`, info)
        .then((g) => {
          cache.current.set(layer, g);
          setError(null);
          bump((n) => n + 1);
          return g;
        })
        .catch((e: unknown) => {
          inflight.current.delete(layer);
          setError(e instanceof Error ? e.message : String(e));
          throw e;
        });
      inflight.current.set(layer, p);
      return p;
    },
    [manifest]
  );

  useEffect(() => {
    ensure(prefetch).catch(() => {});
  }, [ensure, prefetch]);

  const get = useCallback((layer: number) => cache.current.get(layer), []);
  return { get, ensure, error };
}
