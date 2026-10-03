"use client";

import {
  createEdgeArrowHeadProgram,
  createEdgeCompoundProgram,
  EdgeProgram,
} from "sigma/rendering";
import type { ProgramInfo } from "sigma/rendering";
import type {
  EdgeDisplayData,
  NodeDisplayData,
  RenderParams,
} from "sigma/types";

import type {
  EdgeAttributes,
  NodeAttributes,
} from "@/features/graph/graphModel";

/**
 * Curved edges for the ours renderer. Sigma 3.0.3 ships only straight edge
 * programs (line, arrow, rectangle, triangle, clamped), so the body is ours,
 * built on its instancing machinery: per-edge attributes carry the quadratic
 * bezier (source, control, target) and per-vertex constants carry (t, side),
 * with the curve evaluated in the vertex shader. Per-frame JS cost is one
 * instance write per edge -- the same as the stock clamped body -- instead
 * of a CPU-tessellated strip. Focused edges pair that body with sigma's own
 * arrow head (see CurvedArrowProgram below).
 *
 * The bow direction follows the DIRECTED chord's perpendicular, which is
 * already antisymmetric: a mutual A->B / B->A pair bows apart and both stay
 * readable, the way graphify's curves do.
 */

const SEGMENTS = 8;
// Bow height as a fraction of chord length. Barely bent on purpose: direction
// stays readable at rest zoom without looping back on itself (measured:
// 0.6 loops, 0.22 arcs, 0.12 a slight bend, 0.06 a whisper).
const ROUNDNESS = 0.06;

function controlPoint(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): [number, number] {
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len === 0) return [mx, my];
  // The perpendicular of the DIRECTED chord is already antisymmetric:
  // swapping source and target flips (dx, dy), which flips the bow, so a
  // mutual A->B / B->A pair separates on its own. An extra sign factor here
  // flips it back and stacks both edges on the same bow (measured: the red
  // edge hid exactly under the green one).
  const h = ROUNDNESS;
  return [mx - dy * h, my + dx * h];
}

// sigma/rendering keeps floatColor internal, so this is its equivalent for
// the #rgb / #rrggbb this graph uses. It must reinterpret the bytes, not
// compute the float arithmetically: r + g*256 + ... rounds in float32 and
// destroys the low bytes (measured: red rendered blue, white yellow).
// Shared buffer matches sigma's rgbaToFloat, including its alpha masking:
// alpha byte 254 with the fragment shader's 255/254 bias restoring 1.0.
const colorBuffer = new ArrayBuffer(4);
const colorBytes = new Uint8Array(colorBuffer);
const colorFloat = new Float32Array(colorBuffer);

function floatColor(hex: string): number {
  let h = hex.startsWith("#") ? hex.slice(1) : hex;
  if (h.length === 3) {
    h =
      h.slice(0, 1).repeat(2) +
      h.slice(1, 2).repeat(2) +
      h.slice(2, 3).repeat(2);
  }
  let r = 255;
  let g = 255;
  let b = 255;
  if (h.length === 6) {
    const pr = parseInt(h.slice(0, 2), 16);
    const pg = parseInt(h.slice(2, 4), 16);
    const pb = parseInt(h.slice(4, 6), 16);
    if (!Number.isNaN(pr) && !Number.isNaN(pg) && !Number.isNaN(pb)) {
      r = pr;
      g = pg;
      b = pb;
    }
  }
  colorBytes[0] = r;
  colorBytes[1] = g;
  colorBytes[2] = b;
  colorBytes[3] = 254;
  return colorFloat[0] ?? 0;
}

const FRAGMENT_SHADER_SOURCE = /*glsl*/ `
precision mediump float;

varying vec4 v_color;

void main(void) {
  gl_FragColor = v_color;
}
`;

const BODY_VERTEX_SHADER_SOURCE = /*glsl*/ `
attribute vec2 a_p0;
attribute vec2 a_p1;
attribute vec2 a_p2;
attribute float a_thickness;
attribute vec4 a_color;
attribute vec4 a_id;
attribute float a_t;
attribute float a_side;

uniform mat3 u_matrix;
uniform float u_sizeRatio;
uniform float u_correctionRatio;
uniform float u_minEdgeThickness;

varying vec4 v_color;

const float bias = 255.0 / 254.0;

vec2 bez(vec2 a, vec2 b, vec2 c, float t) {
  float u = 1.0 - t;
  return u * u * a + 2.0 * u * t * b + t * t * c;
}

vec2 bezTangent(vec2 a, vec2 b, vec2 c, float t) {
  return 2.0 * (1.0 - t) * (b - a) + 2.0 * t * (c - b);
}

void main() {
  vec2 center = bez(a_p0, a_p1, a_p2, a_t);
  vec2 tangent = bezTangent(a_p0, a_p1, a_p2, a_t);
  float len = length(tangent);
  vec2 unitNormal = len > 0.0 ? vec2(-tangent.y, tangent.x) / len : vec2(0.0);
  // minEdgeThickness is a setting, not a constant: sigma defaults it to 1.7,
  // which is what matted the rest view, and GraphCanvas lowers it. The 0.5
  // floor beside it is ours -- the data value is 0.35, which would sub-pixel
  // away entirely rather than fade.
  float minThickness = u_minEdgeThickness;
  float pixelsThickness = max(max(a_thickness, 0.5), minThickness * u_sizeRatio);
  float webGLThickness = pixelsThickness * u_correctionRatio / u_sizeRatio;
  vec2 position = center + unitNormal * (a_side * webGLThickness);

  gl_Position = vec4((u_matrix * vec3(position, 1)).xy, 0, 1);

  #ifdef PICKING_MODE
  v_color = a_id;
  #else
  v_color = a_color;
  #endif

  v_color.a *= bias;
}
`;

// Parameterized with the graph's attribute types so the classes register
// under Sigma's edgeProgramClasses without pulling constructor inference
// back to the default Attributes.
class EdgeCurvedLineProgram extends EdgeProgram<
  string,
  NodeAttributes,
  EdgeAttributes
> {
  getDefinition() {
    const constantData: number[][] = [];
    for (let i = 0; i <= SEGMENTS; i++) {
      const t = i / SEGMENTS;
      constantData.push([t, -1], [t, 1]);
    }
    return {
      VERTICES: (SEGMENTS + 1) * 2,
      VERTEX_SHADER_SOURCE: BODY_VERTEX_SHADER_SOURCE,
      FRAGMENT_SHADER_SOURCE,
      METHOD: WebGLRenderingContext.TRIANGLE_STRIP,
      UNIFORMS: ["u_matrix", "u_sizeRatio", "u_correctionRatio", "u_minEdgeThickness"],
      ATTRIBUTES: [
        { name: "a_p0", size: 2, type: WebGLRenderingContext.FLOAT },
        { name: "a_p1", size: 2, type: WebGLRenderingContext.FLOAT },
        { name: "a_p2", size: 2, type: WebGLRenderingContext.FLOAT },
        { name: "a_thickness", size: 1, type: WebGLRenderingContext.FLOAT },
        {
          name: "a_color",
          size: 4,
          type: WebGLRenderingContext.UNSIGNED_BYTE,
          normalized: true,
        },
        {
          name: "a_id",
          size: 4,
          type: WebGLRenderingContext.UNSIGNED_BYTE,
          normalized: true,
        },
      ],
      CONSTANT_ATTRIBUTES: [
        { name: "a_t", size: 1, type: WebGLRenderingContext.FLOAT },
        { name: "a_side", size: 1, type: WebGLRenderingContext.FLOAT },
      ],
      CONSTANT_DATA: constantData,
    };
  }

  processVisibleItem(
    edgeIndex: number,
    startIndex: number,
    sourceData: NodeDisplayData,
    targetData: NodeDisplayData,
    data: EdgeDisplayData,
  ): void {
    const array = this.array;
    const [cx, cy] = controlPoint(
      sourceData.x,
      sourceData.y,
      targetData.x,
      targetData.y,
    );
    array[startIndex++] = sourceData.x;
    array[startIndex++] = sourceData.y;
    array[startIndex++] = cx;
    array[startIndex++] = cy;
    array[startIndex++] = targetData.x;
    array[startIndex++] = targetData.y;
    array[startIndex++] = typeof data.size === "number" ? data.size : 1;
    array[startIndex++] = floatColor(data.color);
    array[startIndex++] = edgeIndex;
  }

  setUniforms(params: RenderParams, programInfo: ProgramInfo): void {
    const { gl, uniformLocations } = programInfo;
    gl.uniformMatrix3fv(
      uniformLocations["u_matrix"] ?? null,
      false,
      params.matrix,
    );
    gl.uniform1f(uniformLocations["u_sizeRatio"] ?? null, params.sizeRatio);
    gl.uniform1f(
      uniformLocations["u_correctionRatio"] ?? null,
      params.correctionRatio,
    );
    gl.uniform1f(
      uniformLocations["u_minEdgeThickness"] ?? null,
      params.minEdgeThickness,
    );
  }
}

/**
 * The same curve, dashed: runtime links (ADR-0009), which are drawn over the
 * import graph and must not read as imports. The dash runs along the curve's
 * parameter scaled by the chord's on-screen length, so the period stays
 * roughly constant whatever the edge's length or the zoom. Picking keeps the
 * full stroke, so the gaps do not make an edge harder to hit.
 */
const DASHED_VERTEX_SHADER_SOURCE = BODY_VERTEX_SHADER_SOURCE.replace(
  "varying vec4 v_color;",
  "varying vec4 v_color;\nvarying float v_dash;",
).replace(
  "  gl_Position = vec4((u_matrix * vec3(position, 1)).xy, 0, 1);",
  `  gl_Position = vec4((u_matrix * vec3(position, 1)).xy, 0, 1);
  // Clip-space chord length: 2.0 spans the viewport, so 40 periods per unit
  // is a dash about every 14px on a full-width pane.
  float chord = length((u_matrix * vec3(a_p2 - a_p0, 0)).xy);
  v_dash = a_t * chord * 40.0;`,
);

const DASHED_FRAGMENT_SHADER_SOURCE = /*glsl*/ `
precision mediump float;

varying vec4 v_color;
varying float v_dash;

void main(void) {
  #ifndef PICKING_MODE
  if (fract(v_dash) > 0.55) discard;
  #endif
  gl_FragColor = v_color;
}
`;

class EdgeCurvedDashedProgram extends EdgeCurvedLineProgram {
  getDefinition() {
    return {
      ...super.getDefinition(),
      VERTEX_SHADER_SOURCE: DASHED_VERTEX_SHADER_SOURCE,
      FRAGMENT_SHADER_SOURCE: DASHED_FRAGMENT_SHADER_SOURCE,
    };
  }
}

// Focused edges pair the curved body with the stock arrow head. The head
// orients along the chord rather than the curve's end tangent (off by up to
// ~24 degrees at this roundness), because a tangent-oriented subclass of the
// stock head -- same shaders, same uniforms, sane logged values -- renders
// nothing with no error, and the mechanism never surfaced through the probe
// page. Revisit with /curve-probe?case=4 if sigma's head program changes.
export const CurvedArrowProgram = createEdgeCompoundProgram([
  EdgeCurvedLineProgram,
  createEdgeArrowHeadProgram<NodeAttributes, EdgeAttributes>(),
]);

export { EdgeCurvedDashedProgram, EdgeCurvedLineProgram };
