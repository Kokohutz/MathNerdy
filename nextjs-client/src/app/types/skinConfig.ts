interface SkinConfig {
  buttonText: string;
  logoSrc: string;
  welcomeText?: string;
  welcomeScreenLogoSrc: string;
  greetingSrc: string;
  styles: {
    backgroundColor: string;
    secondaryColor: string;
    mainFont: string;
    logoBackgroundColor: string;
    fontColorOnBackground: string;
    speakingPulseColor: string;
    thinkingColor: string;
  };
}
const SkinConfigurations: Record<string, SkinConfig> = {
  "math-tutor": {
    buttonText: "Start Learning",
    logoSrc: "/groqlabs-logo-black.png",
    welcomeScreenLogoSrc: "/groqlabs-logo-black.png",
    greetingSrc: "/greeting.mp3",
    styles: {
      backgroundColor: "#fff5f0",
      secondaryColor: "#F55036",
      mainFont: "Open Sans, Arial, Helvetica, sans-serif",
      logoBackgroundColor: "#ffe3d6",
      fontColorOnBackground: "#333",
      speakingPulseColor: "#F15950",
      thinkingColor: "#F15950"
    }
  },
  "pizza-agent": {
    buttonText: "Start Order",
    logoSrc: "/pizza-logo.png",
    welcomeScreenLogoSrc: "/pizza-logo-with-text.png",
    greetingSrc: "/pizza-greeting.mp3",
    styles: {
      backgroundColor: "#ffe8ba",
      secondaryColor: "#f9b407",
      mainFont: "Open Sans, Arial, Helvetica, sans-serif",
      logoBackgroundColor: "#faf5a3",
      fontColorOnBackground: "#333",
      speakingPulseColor: "#f9b407",
      thinkingColor: "#f9b407"
    }
  },
  "shoe-agent": {
    buttonText: "Start Order",
    logoSrc: "/shoe-logo.png",
    welcomeScreenLogoSrc: "/shoe-logo-with-text.png",
    greetingSrc: "/shoe-greeting.mp3",
    styles: {
      backgroundColor: "#e8f5e9",
      secondaryColor: "#0e970b",
      mainFont: "Open Sans, Arial, Helvetica, sans-serif",
      logoBackgroundColor: "#43b14b",
      fontColorOnBackground: "#333",
      speakingPulseColor: "#43b14b",
      thinkingColor: "#43b14b"
    }
  }
};

export type { SkinConfig };
export { SkinConfigurations };
