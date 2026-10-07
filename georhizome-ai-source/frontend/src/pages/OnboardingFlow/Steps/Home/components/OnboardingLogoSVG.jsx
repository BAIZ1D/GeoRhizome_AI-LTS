import { useTheme } from "@/hooks/useTheme";
import LightLogo from "@/media/illustrations/login-logo-light.svg";
import DarkLogo from "@/media/illustrations/login-logo.svg";

export function OnboardingLogoSVG() {
  const { isLight } = useTheme();
  return (
    <img
      src={isLight ? LightLogo : DarkLogo}
      alt="GeoRhizome AI Logo"
      className="w-full h-auto max-h-[300px] object-contain"
    />
  );
}
