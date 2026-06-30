import { ActivatedRouteSnapshot, DetachedRouteHandle, RouteReuseStrategy } from '@angular/router';

export class DashboardReuseStrategy implements RouteReuseStrategy {
  /* Computed - cache of detached route handles keyed by their resolved path */
  private stored = new Map<string, DetachedRouteHandle>();

  /*
   * Builds a unique string key for a route by joining all non-empty path segments from root.
   * @param route - The activated route snapshot to derive the key from (required)
   * @returns The full path string representing the route
   */
  private key(route: ActivatedRouteSnapshot): string {
    return route.pathFromRoot
      .map(r => r.routeConfig?.path ?? '')
      .filter(p => p.length > 0)
      .join('/');
  }

  /*
   * Determines whether the router should detach this route and store it for later reuse.
   * Only detaches the dashboard route.
   * @param route - The activated route snapshot being evaluated (required)
   * @returns True when the route path is 'dashboard'
   */
  shouldDetach(route: ActivatedRouteSnapshot): boolean {
    return this.key(route) === 'dashboard';
  }

  /*
   * Stores a detached route handle in the internal cache for future reattachment.
   * @param route - The activated route snapshot whose key identifies the entry (required)
   * @param handle - The detached route handle to cache, or null to skip storing (required)
   */
  store(route: ActivatedRouteSnapshot, handle: DetachedRouteHandle | null): void {
    if (handle) {
      this.stored.set(this.key(route), handle);
    }
  }

  /*
   * Determines whether a previously stored handle exists for this route.
   * @param route - The activated route snapshot to look up (required)
   * @returns True when a cached handle is available for this route
   */
  shouldAttach(route: ActivatedRouteSnapshot): boolean {
    return this.stored.has(this.key(route));
  }

  /*
   * Retrieves the cached route handle for a given route, if available.
   * @param route - The activated route snapshot to look up (required)
   * @returns The cached DetachedRouteHandle or null if none exists
   */
  retrieve(route: ActivatedRouteSnapshot): DetachedRouteHandle | null {
    return this.stored.get(this.key(route)) ?? null;
  }

  /*
   * Determines whether the same route config should be reused between navigations.
   * @param future - The incoming route snapshot (required)
   * @param curr - The currently active route snapshot (required)
   * @returns True when both snapshots share the same route configuration object
   */
  shouldReuseRoute(future: ActivatedRouteSnapshot, curr: ActivatedRouteSnapshot): boolean {
    return future.routeConfig === curr.routeConfig;
  }
}
