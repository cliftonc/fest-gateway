import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App.tsx";
import "./styles.css";

/**
 * `staleTime` of half a minute with a one-minute background refetch: the
 * underlying rollup only changes hourly and the raw path only as fast as the
 * sink flushes, so polling harder would add load without adding information.
 * The one genuinely live surface is `/api/live`, which pushes.
 *
 * Retry is off. Every endpoint here is a local read; a failure means the
 * gateway is down or a query is broken, and silently retrying three times just
 * delays that news by several seconds.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchInterval: 60_000,
      refetchOnWindowFocus: true,
      retry: false,
    },
  },
});

const root = document.getElementById("root");
if (root === null) throw new Error("fest: #root is missing from index.html");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
