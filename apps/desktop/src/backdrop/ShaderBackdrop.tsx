/* Animated living-gradient backdrop on react-three-fiber v9 (React-19-native).
   A fullscreen clip-space quad + a custom GLSL flowing rose/violet mesh — the
   shadergradient look, without the shadergradient library (which bundles r3f v8
   and crashes React 19; see Backdrop.tsx). Lazy-imported so three.js stays off the
   critical path. Theme-aware: uniform colors come from colors.ts (the one place a
   concrete hex may live, since a shader can't read CSS vars). */

import { Canvas, useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { Color, type ShaderMaterial } from 'three';
import type { Theme } from '../appearance/theme';
import { backdropColors } from './colors';

// Fullscreen quad: ignore the camera, emit clip-space directly (planeGeometry [2,2] → -1..1).
const vert = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// Subtle flowing mesh: domain-warped sine field blends three palette stops, vignetted to base.
const frag = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;
  uniform vec3 uColor1; // base (near-bg)
  uniform vec3 uColor2; // rose
  uniform vec3 uColor3; // violet

  float wave(vec2 p, float t) {
    return sin(p.x * 3.0 + t)
         + sin(p.y * 2.3 - t * 1.2)
         + sin((p.x + p.y) * 1.7 + t * 0.6);
  }

  void main() {
    vec2 uv = vUv;
    float t = uTime * 0.15;
    vec2 q = uv + 0.12 * vec2(sin(uv.y * 3.0 + t), cos(uv.x * 3.0 - t));
    float n = wave(q * 1.5, t);
    float m = 0.5 + 0.5 * sin(n);
    float g = smoothstep(0.0, 1.0, uv.y + 0.25 * sin(t + uv.x * 2.5));
    vec3 col = mix(uColor1, uColor2, g);
    col = mix(col, uColor3, m * 0.55);
    float vig = smoothstep(1.3, 0.2, length(uv - 0.5));
    col = mix(uColor1, col, vig);
    gl_FragColor = vec4(col, 1.0);
  }
`;

function GradientMesh({ theme }: { theme: Theme }) {
  const mat = useRef<ShaderMaterial>(null);

  // Init uniforms once with the mount-time theme; theme changes update them via the effect.
  const uniforms = useMemo(() => {
    const c = backdropColors(theme);
    return {
      uTime: { value: 0 },
      uColor1: { value: new Color(c.color1) },
      uColor2: { value: new Color(c.color2) },
      uColor3: { value: new Color(c.color3) },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- init only; updates handled below
  }, []);

  useEffect(() => {
    const c = backdropColors(theme);
    uniforms.uColor1.value.set(c.color1);
    uniforms.uColor2.value.set(c.color2);
    uniforms.uColor3.value.set(c.color3);
  }, [theme, uniforms]);

  useFrame((_, dt) => {
    if (mat.current) mat.current.uniforms.uTime.value += dt;
  });

  return (
    <mesh>
      <planeGeometry args={[2, 2]} />
      <shaderMaterial ref={mat} uniforms={uniforms} vertexShader={vert} fragmentShader={frag} />
    </mesh>
  );
}

export default function ShaderBackdrop({ theme }: { theme: Theme }) {
  return (
    <Canvas
      aria-hidden
      gl={{ antialias: false, powerPreference: 'low-power' }}
      dpr={[1, 1.5]}
      frameloop="always"
      style={{ position: 'fixed', inset: 0, zIndex: 0, opacity: 0.8, pointerEvents: 'none' }}
    >
      <GradientMesh theme={theme} />
    </Canvas>
  );
}
