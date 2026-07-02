import { createRootRoute, Outlet } from "@tanstack/react-router";

// The <html>/<body> shell lives in index.html; the root route is just the
// outlet the child routes render into.
export const Route = createRootRoute({
  component: () => <Outlet />,
});
