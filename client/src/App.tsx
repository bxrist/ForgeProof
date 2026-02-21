import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/components/ThemeProvider";
import NotFound from "@/pages/not-found";
import LandingPage from "@/pages/landing";
import DashboardPage from "@/pages/dashboard";
import AttestationDetailPage from "@/pages/attestation-detail";
import DemoPage from "@/pages/demo";
import DemoAttestationDetailPage from "@/pages/demo-attestation-detail";
import VerifyPage from "@/pages/verify";

function Router() {
  return (
    <Switch>
      <Route path="/" component={LandingPage} />
      <Route path="/demo" component={DemoPage} />
      <Route path="/demo/attestation/:id" component={DemoAttestationDetailPage} />
      <Route path="/dashboard" component={DashboardPage} />
      <Route path="/attestation/:id" component={AttestationDetailPage} />
      <Route path="/verify" component={VerifyPage} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
