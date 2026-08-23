/* ============================================================
   m4.js - the ~2kB slice of a matrix library this game needs.
   Column-major Float32Array(16), same convention as WebGL.
   ============================================================ */

export const create = () => new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);

export function identity(o = create()) {
  o[0]=1;o[1]=0;o[2]=0;o[3]=0; o[4]=0;o[5]=1;o[6]=0;o[7]=0;
  o[8]=0;o[9]=0;o[10]=1;o[11]=0; o[12]=0;o[13]=0;o[14]=0;o[15]=1;
  return o;
}

export function multiply(a, b, o = create()) {
  const a00=a[0],a01=a[1],a02=a[2],a03=a[3], a10=a[4],a11=a[5],a12=a[6],a13=a[7],
        a20=a[8],a21=a[9],a22=a[10],a23=a[11], a30=a[12],a31=a[13],a32=a[14],a33=a[15];
  for (let i = 0; i < 4; i++) {
    const b0=b[i*4], b1=b[i*4+1], b2=b[i*4+2], b3=b[i*4+3];
    o[i*4]   = b0*a00 + b1*a10 + b2*a20 + b3*a30;
    o[i*4+1] = b0*a01 + b1*a11 + b2*a21 + b3*a31;
    o[i*4+2] = b0*a02 + b1*a12 + b2*a22 + b3*a32;
    o[i*4+3] = b0*a03 + b1*a13 + b2*a23 + b3*a33;
  }
  return o;
}

export function perspective(fovy, aspect, near, far, o = create()) {
  const f = 1 / Math.tan(fovy / 2);
  o.fill(0);
  o[0] = f / aspect; o[5] = f; o[11] = -1;
  o[10] = (far + near) / (near - far);
  o[14] = (2 * far * near) / (near - far);
  return o;
}

export function ortho(l, r, b, t, n, f, o = create()) {
  o.fill(0);
  o[0] = 2/(r-l); o[5] = 2/(t-b); o[10] = -2/(f-n); o[15] = 1;
  o[12] = -(r+l)/(r-l); o[13] = -(t+b)/(t-b); o[14] = -(f+n)/(f-n);
  return o;
}

export function lookAt(eye, target, up, o = create()) {
  let zx = eye[0]-target[0], zy = eye[1]-target[1], zz = eye[2]-target[2];
  let l = Math.hypot(zx,zy,zz) || 1; zx/=l; zy/=l; zz/=l;
  let xx = up[1]*zz - up[2]*zy, xy = up[2]*zx - up[0]*zz, xz = up[0]*zy - up[1]*zx;
  l = Math.hypot(xx,xy,xz) || 1; xx/=l; xy/=l; xz/=l;
  const yx = zy*xz - zz*xy, yy = zz*xx - zx*xz, yz = zx*xy - zy*xx;
  o[0]=xx; o[1]=yx; o[2]=zx; o[3]=0;
  o[4]=xy; o[5]=yy; o[6]=zy; o[7]=0;
  o[8]=xz; o[9]=yz; o[10]=zz; o[11]=0;
  o[12]=-(xx*eye[0]+xy*eye[1]+xz*eye[2]);
  o[13]=-(yx*eye[0]+yy*eye[1]+yz*eye[2]);
  o[14]=-(zx*eye[0]+zy*eye[1]+zz*eye[2]);
  o[15]=1;
  return o;
}

/** Compose translate * rotY * rotX * rotZ * scale - the only order the game uses. */
export function compose(px, py, pz, rx, ry, rz, sx, sy, sz, o = create()) {
  const cx=Math.cos(rx), sxr=Math.sin(rx);
  const cy=Math.cos(ry), syr=Math.sin(ry);
  const cz=Math.cos(rz), szr=Math.sin(rz);
  // R = Ry * Rx * Rz
  const m00 = cy*cz + syr*sxr*szr, m01 = cx*szr,  m02 = -syr*cz + cy*sxr*szr;
  const m10 = -cy*szr + syr*sxr*cz, m11 = cx*cz,  m12 = syr*szr + cy*sxr*cz;
  const m20 = syr*cx,               m21 = -sxr,   m22 = cy*cx;
  o[0]=m00*sx; o[1]=m01*sx; o[2]=m02*sx; o[3]=0;
  o[4]=m10*sy; o[5]=m11*sy; o[6]=m12*sy; o[7]=0;
  o[8]=m20*sz; o[9]=m21*sz; o[10]=m22*sz; o[11]=0;
  o[12]=px; o[13]=py; o[14]=pz; o[15]=1;
  return o;
}

export function transformPoint(m, x, y, z, out = [0,0,0]) {
  out[0] = m[0]*x + m[4]*y + m[8]*z + m[12];
  out[1] = m[1]*x + m[5]*y + m[9]*z + m[13];
  out[2] = m[2]*x + m[6]*y + m[10]*z + m[14];
  return out;
}

export function transformDir(m, x, y, z, out = [0,0,0]) {
  out[0] = m[0]*x + m[4]*y + m[8]*z;
  out[1] = m[1]*x + m[5]*y + m[9]*z;
  out[2] = m[2]*x + m[6]*y + m[10]*z;
  return out;
}

/** project a world point to normalised device coords; returns null when behind camera */
export function project(vp, x, y, z) {
  const cx = vp[0]*x + vp[4]*y + vp[8]*z  + vp[12];
  const cy = vp[1]*x + vp[5]*y + vp[9]*z  + vp[13];
  const cw = vp[3]*x + vp[7]*y + vp[11]*z + vp[15];
  if (cw <= 0.0001) return null;
  return [cx / cw, cy / cw];
}

/** upper-left 3x3, for normals (uniform scale only, which is all we use) */
export function normalMat3(m, o = new Float32Array(9)) {
  o[0]=m[0]; o[1]=m[1]; o[2]=m[2];
  o[3]=m[4]; o[4]=m[5]; o[5]=m[6];
  o[6]=m[8]; o[7]=m[9]; o[8]=m[10];
  return o;
}
