import React from 'react';

interface DialogProps {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
}

const Dialog: React.FC<DialogProps> = ({ isOpen, onClose, children }) => {
  if (!isOpen) return null;

  return (
    <div 
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0,0,0,0.85)',
        backdropFilter: 'blur(2px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        animation: 'fadeIn 0.3s ease-out',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        style={{
          backgroundColor: 'rgba(0,0,0,0.95)',
          border: '2px solid #0f0',
          borderRadius: '12px',
          padding: '3rem',
          maxWidth: '90vw',
          maxHeight: '90vh',
          overflow: 'auto',
          boxShadow: `
            0 0 30px #0f0,
            0 0 60px rgba(0,255,0,0.3),
            inset 0 0 20px rgba(0,255,0,0.1)
          `,
          textAlign: 'center',
          color: '#0f0',
          fontFamily: "'Courier New', 'Lucida Console', monospace",
          transform: 'scale(1)',
          animation: 'dialogAppear 0.4s ease-out',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
      
      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        
        @keyframes dialogAppear {
          from { 
            opacity: 0; 
            transform: scale(0.8) translateY(-20px); 
          }
          to { 
            opacity: 1; 
            transform: scale(1) translateY(0); 
          }
        }
      `}</style>
    </div>
  );
};

export default Dialog; 