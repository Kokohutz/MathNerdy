"use client";

import Image from "next/image";
import { useMemo } from "react";
import { useMicVAD } from "@ricky0123/vad-react"

import { SkinConfigurations } from "./types/skinConfig";

import { SyncLoader, PulseLoader, ScaleLoader } from "react-spinners";

import { Header } from "./components/header";
import { IntroPopup } from "./components/intro-popup";
import { MarkdownLatex } from "./components/markdown-latex";

import xRxClient from "../../../xrx-core/react-xrx-client/src";

declare global {
  interface Window {
    webkitAudioContext: typeof AudioContext;
  }
}

const NEXT_PUBLIC_ORCHESTRATOR_HOST =
  process.env.NEXT_PUBLIC_ORCHESTRATOR_HOST || "localhost";
const NEXT_PUBLIC_ORCHESTRATOR_PORT =
  process.env.NEXT_PUBLIC_ORCHESTRATOR_PORT || "8000";
const NEXT_PUBLIC_ORCHESTRATOR_PATH =
  process.env.NEXT_PUBLIC_ORCHESTRATOR_PATH || "/api/v1/ws";
const NEXT_PUBLIC_UI_DEBUG_MODE =
  process.env.NEXT_PUBLIC_UI_DEBUG_MODE === "true";
const TTS_SAMPLE_RATE = process.env.TTS_SAMPLE_RATE || "24000";
const STT_SAMPLE_RATE = process.env.STT_SAMPLE_RATE || "16000";
const NEXT_PUBLIC_GREETING_FILENAME = process.env.NEXT_PUBLIC_GREETING_FILENAME || "greeting.mp3";
  
// see SkinConfigurations for available agents
const NEXT_PUBLIC_AGENT = process.env.NEXT_PUBLIC_AGENT || "math-tutor";
const skinConfig = SkinConfigurations[NEXT_PUBLIC_AGENT];


export default function Home() {

  const {
    // State variables
    isRecording,
    isVoiceMode,
    isUserSpeaking,
    chatHistory,
    isAgentSpeaking,
    isAgentThinking,
    // isAudioPlaying,
    showStartButton,
    // isAudioGenerationDone,

    // Set functions
    // setIsRecording,
    // setIsVoiceMode,
    setIsUserSpeaking,
    // setChatHistory,
    // setIsAgentSpeaking,
    // setIsAgentThinking,
    // setIsAudioPlaying,
    // setShowStartButton,
    // setIsAudioGenerationDone,

    // Handler functions
    startAgent,
    toggleIsRecording,
    toggleVoiceMode,
    // sendMessage,
    // sendAction

  } = xRxClient({
    orchestrator_host: NEXT_PUBLIC_ORCHESTRATOR_HOST,
    orchestrator_port: NEXT_PUBLIC_ORCHESTRATOR_PORT,
    orchestrator_path: NEXT_PUBLIC_ORCHESTRATOR_PATH,
    greeting_filename: NEXT_PUBLIC_GREETING_FILENAME,
    orchestrator_ssl: false,
    stt_sample_rate: parseInt(STT_SAMPLE_RATE, 10),
    tts_sample_rate: parseInt(TTS_SAMPLE_RATE, 10),
  });

  /* Voice Activity Detection */
  useMicVAD({
    startOnLoad: true,
    onSpeechStart: () => {
      console.log("User started talking");
      if (isRecording){
        setIsUserSpeaking(true);
      }
    },
    onSpeechEnd: () => {
      console.log("User stopped talking");
      setIsUserSpeaking(false);
    },
  })

  /* Click Handlers */
  const handleStartClick = () => {
    startAgent();
  }
  
  const handleRecordClick = () => {
    toggleIsRecording();
  }

  const renderedWidgets = useMemo(() => {
    console.log(JSON.stringify(chatHistory));

    let widget:any = chatHistory.findLast(chat => chat.type === 'widget')?.message;
    let details: any;
    if (!widget){
      return null;
    }

    try { 
      details = JSON.parse(widget.details);
    } catch (error) {
      console.log("Error: we received invalid json for the widget.");
      console.log(error);
      console.log(widget.details);
      details = [];
    }

    if (Array.isArray(details) && details.length > 0) {

      return details.map((widget, index) => {
        const { type, parameters, data } = widget;
        console.log("Rendering widget: ",type,parameters,data);

        switch (type) {
          case 'defineWhiteboard':
            return (
              <div key={`widget-${index}`} className="flex items-center justify-center min-h-[60%] min-w-[60%]">
                  <MarkdownLatex content={parameters.content}></MarkdownLatex>
              </div>
            );
          default:
            return null;
        }
      });
    }
  }, [chatHistory]);


  return (
    <main className="mainContainer">
      <Header />
      <IntroPopup />
    {showStartButton && (
      <div className="startButtonContainer">
        <button className="widget-button" style={{padding: '10px 30px'}} onClick={handleStartClick}>Start</button>
      </div>
    )}
    <div className="chatContainer flex-auto">
      <div className={`iconContainer flex ${!isVoiceMode ? 'hidden' : ''}`}>
        <SyncLoader
                color={"#F15950"}
                loading={isAgentSpeaking}
                size={20}
                />
        <PulseLoader
            color={"#F15950"}
            loading={isAgentThinking}
            size={20}
            />

        <div style={{
          width: isAgentSpeaking || isAgentThinking ? '0px' : '50px',
          height: isAgentSpeaking || isAgentThinking ? '0px' : '50px',
          borderRadius: '50%',
          backgroundColor: '#F15950',
          transition: 'all 0.5s',
          position: 'absolute',
          left: '50%',
          top: '40',
          transform: isAgentSpeaking || isAgentThinking ? 'translate(-50%, 0) scale(0)' : 'translate(-50%, 0) scale(1)',
          transformOrigin: 'center center'
        }}></div>
        
      </div>
      <div />
<div className="chatMessageContainer flex">
  <div className="widgetMessageContainer">
    <div key="widget" className="chatMessage widgetMessage">
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, calc(50% - 10px)), 1fr))',
      gap: '1rem',
      justifyContent: 'center',
      alignContent: 'center',
      width: '100vw',
      // height: 'calc(100vh - 600px)',
      padding: '3rem',
      boxSizing: 'border-box',
    }}
    className="grid-container">
      {renderedWidgets}
      </div>
    </div>
  </div>
</div>
    </div>
    <div className="inputContainer border-t bg-gradient-to-b from-white/80 via-white/95 to-white backdrop-blur-xl">
      <div className='flex'>
          <div className="textInputContainer" >
            <div id='speechDetection' style={{ justifyContent: 'center' }}>
              <ScaleLoader
                className="voiceIndicator"
                color={"rgb(var(--foreground-rgb))"}
                loading={isRecording && isUserSpeaking}
                radius={10}
                height={20}
                width={20}
                speedMultiplier={2}
              />
              <ScaleLoader
                className="voiceIndicator"
                color={"rgb(var(--foreground-rgb))"}
                loading={!isRecording || !isUserSpeaking}
                radius={5}
                height={7}
                width={20}
                speedMultiplier={0.00001}
              />
              <Image
                className="micButton"
                src={isRecording ? "/mic_on.svg" : "/mic_off.svg"}
                width={50}
                height={50}
                alt="Microphone Icon"
                onClick={handleRecordClick}
                style={{ marginLeft: 'auto' }}
              />
            </div>
          </div>
      </div>   
      <div className='speechControls'>
        {NEXT_PUBLIC_UI_DEBUG_MODE && (
          <button className="modeButton" onClick={() => toggleVoiceMode()}>
            <Image
              src={isVoiceMode ? '/chat.svg' : '/mic_on.svg'} 
              width={20} 
              height={10} 
              alt="Microphone Icon"
            />
            <span>{isVoiceMode ? 'Toggle to text mode' : 'Toggle to audio mode'}</span>
          </button>
        )}
      </div>    
    </div>
  </main>
);
}
