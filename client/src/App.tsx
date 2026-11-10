import { Switch, Route, Redirect, Router as WouterRouter } from "wouter";
import { Show } from "@clerk/react";
import { basePath, ForgeProofClerkProvider, ClerkQueryClientCacheInvalidator, SignInPage, SignUpPage, ProtectedPage } from "@/components/ClerkAuthentication";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/components/ThemeProvider";
import { HelmetProvider } from "react-helmet-async";
import ErrorBoundary from "@/components/ErrorBoundary";
import NotFound from "@/pages/not-found";
import LandingPage from "@/pages/landing";
import DashboardPage from "@/pages/dashboard";
import AttestationDetailPage from "@/pages/attestation-detail";
import DemoPage from "@/pages/demo";
import DemoAttestationDetailPage from "@/pages/demo-attestation-detail";
import VerifyPage from "@/pages/verify";
import LookupPage from "@/pages/lookup";
import SdkPage from "@/pages/sdk";
import AnalyticsPage from "@/pages/analytics";
import ThreatModelPage from "@/pages/threat-model";
import GlossaryPage from "@/pages/glossary";
import AdminStripePage from "@/pages/admin-stripe";

function Router() {
  return (
    <Switch>
      <Route path="/">
        <Show when="signed-in"><Redirect to="/dashboard" /></Show>
        <Show when="signed-out"><LandingPage /></Show>
      </Route>
      <Route path="/sign-in/*?" component={SignInPage} />
      <Route path="/sign-up/*?" component={SignUpPage} />
      <Route path="/demo" component={DemoPage} />
      <Route path="/demo/attestation/:id" component={DemoAttestationDetailPage} />
      <Route path="/dashboard"><ProtectedPage><DashboardPage /></ProtectedPage></Route>
      <Route path="/attestation/:id"><ProtectedPage><AttestationDetailPage /></ProtectedPage></Route>
      <Route path="/verify" component={VerifyPage} />
      <Route path="/lookup" component={LookupPage} />
      <Route path="/sdk" component={SdkPage} />
      <Route path="/analytics" component={AnalyticsPage} />
      <Route path="/threat-model" component={ThreatModelPage} />
      <Route path="/glossary" component={GlossaryPage} />
      <Route path="/admin/stripe"><ProtectedPage><AdminStripePage /></ProtectedPage></Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <HelmetProvider>
      <WouterRouter base={basePath}>
      <ForgeProofClerkProvider>
      <QueryClientProvider client={queryClient}>
        <ClerkQueryClientCacheInvalidator />
        <ThemeProvider>
          <TooltipProvider>
            <ErrorBoundary>
              <Toaster />
              <Router />
            </ErrorBoundary>
          </TooltipProvider>
        </ThemeProvider>
      </QueryClientProvider>
      </ForgeProofClerkProvider>
      </WouterRouter>
    </HelmetProvider>
  );
}

export default App;
