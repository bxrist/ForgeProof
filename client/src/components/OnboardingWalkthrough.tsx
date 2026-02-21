import { useState, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Sparkles,
  FileCheck,
  GitBranch,
  Code2,
  BadgeCheck,
  ChevronLeft,
  ChevronRight,
  X,
} from "lucide-react";

const STORAGE_KEY = "forgeproof_onboarding_complete";

const steps = [
  {
    icon: Sparkles,
    title: "Welcome to ForgeProof!",
    description:
      "ForgeProof provides cryptographic code provenance attestation, helping you prove the origin and integrity of AI-generated code.",
  },
  {
    icon: FileCheck,
    title: "Attest Your Code",
    description:
      "Create attestation receipts for AI-generated code with cryptographic signatures, hash chains, and tamper-proof metadata.",
  },
  {
    icon: GitBranch,
    title: "Connect GitHub",
    description:
      "Link your GitHub repositories to enable automatic attestation whenever AI agents generate or modify code in your projects.",
  },
  {
    icon: Code2,
    title: "API & SDK",
    description:
      "Use the ForgeProof SDK and REST API to integrate attestation directly into your AI agent workflows and CI/CD pipelines.",
  },
  {
    icon: BadgeCheck,
    title: "Verify & Share",
    description:
      "Look up any attestation by hash, embed verification badges in your repos, and export compliance certificates for audits.",
  },
];

export function OnboardingWalkthrough() {
  const [visible, setVisible] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);

  useEffect(() => {
    const seen = localStorage.getItem(STORAGE_KEY);
    if (!seen) {
      setVisible(true);
    }
  }, []);

  const handleComplete = () => {
    localStorage.setItem(STORAGE_KEY, "true");
    setVisible(false);
  };

  const handleSkip = () => {
    handleComplete();
  };

  const handleNext = () => {
    if (currentStep < steps.length - 1) {
      setCurrentStep((s) => s + 1);
    } else {
      handleComplete();
    }
  };

  const handlePrev = () => {
    setCurrentStep((s) => Math.max(0, s - 1));
  };

  if (!visible) return null;

  const step = steps[currentStep];
  const Icon = step.icon;
  const isLast = currentStep === steps.length - 1;
  const isFirst = currentStep === 0;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      data-testid="onboarding-overlay"
    >
      <Card className="relative w-full max-w-md mx-4">
        <Button
          variant="ghost"
          size="icon"
          className="absolute top-3 right-3"
          onClick={handleSkip}
          data-testid="button-onboarding-skip"
        >
          <X className="w-4 h-4" />
        </Button>

        <CardContent className="pt-10 pb-6 px-8">
          <div className="flex flex-col items-center text-center">
            <div className="w-14 h-14 rounded-full bg-primary/10 dark:bg-primary/20 flex items-center justify-center mb-5">
              <Icon className="w-7 h-7 text-primary" />
            </div>

            <h2 className="font-display text-xl font-bold tracking-tight mb-2" data-testid="text-onboarding-title">
              {step.title}
            </h2>
            <p className="text-sm text-muted-foreground leading-relaxed max-w-sm" data-testid="text-onboarding-description">
              {step.description}
            </p>

            <div className="flex items-center gap-1.5 mt-6 mb-6">
              {steps.map((_, i) => (
                <button
                  key={i}
                  className={`w-2 h-2 rounded-full transition-all ${
                    i === currentStep
                      ? "bg-primary w-5"
                      : "bg-muted-foreground/30"
                  }`}
                  onClick={() => setCurrentStep(i)}
                  data-testid={`button-onboarding-dot-${i}`}
                />
              ))}
            </div>

            <div className="flex items-center gap-3 w-full">
              {!isFirst && (
                <Button
                  variant="outline"
                  onClick={handlePrev}
                  className="flex-1"
                  data-testid="button-onboarding-prev"
                >
                  <ChevronLeft className="w-4 h-4 mr-1" />
                  Previous
                </Button>
              )}
              {isFirst && (
                <Button
                  variant="ghost"
                  onClick={handleSkip}
                  className="flex-1"
                  data-testid="button-onboarding-skip-text"
                >
                  Skip
                </Button>
              )}
              <Button
                onClick={handleNext}
                className="flex-1"
                data-testid="button-onboarding-next"
              >
                {isLast ? "Get Started" : "Next"}
                {!isLast && <ChevronRight className="w-4 h-4 ml-1" />}
              </Button>
            </div>

            <div className="text-xs text-muted-foreground mt-4">
              Step {currentStep + 1} of {steps.length}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
