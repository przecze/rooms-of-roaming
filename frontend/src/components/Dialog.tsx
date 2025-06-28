import React from 'react';

interface DialogProps {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
}

const Dialog: React.FC<DialogProps> = ({ isOpen, onClose, children }) => {
  if (!isOpen) return null;

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      width: '100vw',
      height: '100vh',
      backgroundColor: 'rgba(0, 0, 0, 0.3)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 1000,
    }}>
      <div style={{
        backgroundColor: 'rgba(0, 0, 0, 0.9)',
        border: '2px solid #0f0',
        borderRadius: '8px',
        padding: '2rem',
        maxWidth: '600px',
        textAlign: 'center',
        fontFamily: "'Courier New', 'Lucida Console', monospace",
        color: '#0f0',
      }}>
        {children}
      </div>
    </div>
  );
};

export default Dialog; 