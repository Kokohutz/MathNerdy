import React, { useState, useEffect } from 'react';
import { Button } from './ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from './ui/card';

const STORAGE_KEY = 'mathtutor-intro-clicked';

export const IntroPopup = () => {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    // Check if the popup has been clicked before
    const hasClickedIntro = localStorage.getItem(STORAGE_KEY);
    if (!hasClickedIntro) {
      setIsVisible(true);
    }
  }, []);

  const handleEnter = () => {
    setIsVisible(false);
    localStorage.setItem(STORAGE_KEY, 'true');
  };

  if (!isVisible) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <Card className="w-full max-w-lg mx-4 sketchy">
        <CardHeader>
          <CardTitle className="text-xl font-semibold text-center">
            Welcome to Math Tutor on Groq
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-4">
            <div className="flex items-start space-x-3">
              <span className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-full hlBadge font-semibold">
                1
              </span>
              <p className="text-sm">
                Math Tutor is in beta and experimental. Feedback and PRs are welcome!
              </p>
            </div>
            
            <div className="flex items-start space-x-3">
              <span className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-full hlBadge font-semibold">
                2
              </span>
              <p className="text-sm">
                Because Math Tutor can be interrupted, environments with significant background noise can lower the quality of your experience. If possible, try using voice isolation mode on your computer, or going to a quiet area.
              </p>
            </div>
            
            <div className="flex items-start space-x-3">
              <span className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-full hlBadge font-semibold">
                3
              </span>
              <p className="text-sm">
                Math Tutor may provide inaccurate or incomplete information. It is an assistant, not an expert. Let us know about inaccuracies!
              </p>
            </div>
          </div>
        </CardContent>
        <CardFooter className="flex justify-center pb-6">
          <Button 
            onClick={handleEnter}
            className="enter-button px-8"
          >
            Enter
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
};

export default IntroPopup;