/* THE numbers of the first-person view: the client's dvars and the field of view as the engine works it out.
 *
 * CG_GetViewFov (cgame_mp/cg_view_mp.cpp): cg_fov, or the weapon's adsZoomFov over the end of the sights' transition, then
 * x cg_fovScale - the scale counts for the sights too - and at least cg_fovMin. CG_UpdateFov: that is the horizontal fov of
 * a 4:3 screen: tanHalfFovY = tan(fov / 2) x 0.75, tanHalfFovX = tanHalfFovY x the screen's aspect. So the height stays and a wider
 * screen sees more at the sides, which is what three's vertical camera.fov with the canvas' aspect does. The view model has no
 * fov of its own (one refdef), only its own near plane (viewmodel.js). */

export const CG_FOV = 80;               // the top value of Promod's menu (ui_mp/options_multi.menu)
export const CG_FOV_SCALE = 1.125;      // Promod's option (promod/client.gsc setFOVScale)
export const CG_FOV_MIN = 10;           // the default of cg_fovMin
// cg_gun_x: 0.2 x the player's PROMOD_GUN_X (promod/client.gsc), 0 unless changed (0.2 .. 1.0 are the other values of the menu);
// y and z: Promod leaves them at the game's 0. Units along the view axes: x forward, y left, z up (cg_weapons.cpp CG_AddViewWeapon)
export const CG_GUN_X = 0;
export const CG_GUN_Y = 0;
export const CG_GUN_Z = 0;
export const R_ZNEAR = 4;               // the world's near plane
export const R_ZNEAR_DEPTHHACK = 0.1;   // the view model's

const D2R = Math.PI / 180;
/** CG_UpdateFov: the vertical fov (deg) of an engine fov (the horizontal one at 4:3) */
export const verticalFov = fov => 2 * Math.atan(Math.tan(fov * D2R / 2) * 0.75) / D2R;

/** CG_GetViewFov. ads: null, or {zoomFov: adsZoomFov, frac: fWeaponPosFrac, zoomFrac: adsZoomInFrac aiming in, else adsZoomOutFrac} */
export function viewFov(ads) {
  let fov = CG_FOV;
  if (ads && ads.frac === 1) fov = ads.zoomFov;
  else if (ads && ads.frac !== 0) {
    const z = (ads.frac - (1 - ads.zoomFrac)) / ads.zoomFrac;
    if (z > 0) fov -= (fov - ads.zoomFov) * z;
  }
  return Math.max(CG_FOV_MIN, fov * CG_FOV_SCALE);
}

export const FP_FOV = verticalFov(viewFov(null));      // the camera's vertical fov without the sights
