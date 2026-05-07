import { ActivatedRouteSnapshot, DetachedRouteHandle, RouteReuseStrategy } from '@angular/router';

export class DashboardReuseStrategy implements RouteReuseStrategy {
  private stored = new Map<string, DetachedRouteHandle>();

  private key(route: ActivatedRouteSnapshot): string {
    return route.pathFromRoot
      .map(r => r.routeConfig?.path ?? '')
      .filter(p => p.length > 0)
      .join('/');
  }

  shouldDetach(route: ActivatedRouteSnapshot): boolean {
    return this.key(route) === 'dashboard';
  }

  store(route: ActivatedRouteSnapshot, handle: DetachedRouteHandle | null): void {
    if (handle) {
      this.stored.set(this.key(route), handle);
    }
  }

  shouldAttach(route: ActivatedRouteSnapshot): boolean {
    return this.stored.has(this.key(route));
  }

  retrieve(route: ActivatedRouteSnapshot): DetachedRouteHandle | null {
    return this.stored.get(this.key(route)) ?? null;
  }

  shouldReuseRoute(future: ActivatedRouteSnapshot, curr: ActivatedRouteSnapshot): boolean {
    return future.routeConfig === curr.routeConfig;
  }
}
