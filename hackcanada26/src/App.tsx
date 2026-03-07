import { useState } from 'react';
import { AdvancedImage, placeholder, lazyload } from '@cloudinary/react';
import { fill } from '@cloudinary/url-gen/actions/resize';
import { format, quality } from '@cloudinary/url-gen/actions/delivery';
import { auto } from '@cloudinary/url-gen/qualifiers/format';
import { auto as autoQuality } from '@cloudinary/url-gen/qualifiers/quality';
import { autoGravity } from '@cloudinary/url-gen/qualifiers/gravity';
import {
  backgroundRemoval,
  generativeBackgroundReplace,
  enhance,
  generativeReplace,
} from '@cloudinary/url-gen/actions/effect';
import { cld, uploadPreset } from './cloudinary/config';
import { UploadWidget } from './cloudinary/UploadWidget';
import type { CloudinaryUploadResult } from './cloudinary/UploadWidget';
import './App.css';

const hasUploadPreset = Boolean(uploadPreset);

/** Defines each AI demo card */
interface AIDemo {
  id: string;
  title: string;
  description: string;
  emoji: string;
  /** Apply the Cloudinary effect to a cloned image builder */
  applyEffect: (imageId: string) => ReturnType<typeof cld.image>;
}

const AI_DEMOS: AIDemo[] = [
  {
    id: 'original',
    title: 'Original Image',
    description: 'The unmodified sample image from Cloudinary — no AI effects applied.',
    emoji: '🖼️',
    applyEffect: (imageId) =>
      cld
        .image(imageId)
        .resize(fill().width(500).height(400).gravity(autoGravity()))
        .delivery(format(auto()))
        .delivery(quality(autoQuality())),
  },
  {
    id: 'bg-removal',
    title: 'AI Background Removal',
    description:
      'Uses deep-learning to detect the subject and make the background transparent — one URL param.',
    emoji: '✂️',
    applyEffect: (imageId) =>
      cld
        .image(imageId)
        .effect(backgroundRemoval())
        .resize(fill().width(500).height(400).gravity(autoGravity()))
        .delivery(format(auto()))
        .delivery(quality(autoQuality())),
  },
  {
    id: 'bg-replace',
    title: 'Generative Background Replace',
    description:
      'AI generates a brand-new background based on a text prompt while keeping the subject intact.',
    emoji: '🌄',
    applyEffect: (imageId) =>
      cld
        .image(imageId)
        .effect(generativeBackgroundReplace().prompt('futuristic neon cityscape at night'))
        .resize(fill().width(500).height(400).gravity(autoGravity()))
        .delivery(format(auto()))
        .delivery(quality(autoQuality())),
  },
  {
    id: 'enhance',
    title: 'AI Enhance',
    description:
      'AI automatically adjusts color, contrast, and lighting to make the image look its best.',
    emoji: '✨',
    applyEffect: (imageId) =>
      cld
        .image(imageId)
        .effect(enhance())
        .resize(fill().width(500).height(400).gravity(autoGravity()))
        .delivery(format(auto()))
        .delivery(quality(autoQuality())),
  },
  {
    id: 'gen-replace',
    title: 'Generative Replace',
    description:
      'AI swaps one object for another — here it replaces the bicycle with a motorcycle, seamlessly.',
    emoji: '🔄',
    applyEffect: (imageId) =>
      cld
        .image(imageId)
        .effect(generativeReplace().from('bicycle').to('motorcycle'))
        .resize(fill().width(500).height(400).gravity(autoGravity()))
        .delivery(format(auto()))
        .delivery(quality(autoQuality())),
  },
];

function App() {
  const [uploadedImageId, setUploadedImageId] = useState<string | null>(null);
  const [activeDemo, setActiveDemo] = useState<string>('original');

  const handleUploadSuccess = (result: CloudinaryUploadResult) => {
    console.log('Upload successful:', result);
    setUploadedImageId(result.public_id);
  };

  const handleUploadError = (error: Error) => {
    console.error('Upload error:', error);
    alert(`Upload failed: ${error.message}`);
  };

  // Use uploaded image or fall back to a Cloudinary sample
  const imageId = uploadedImageId || 'samples/people/bicycle';

  const currentDemo = AI_DEMOS.find((d) => d.id === activeDemo) ?? AI_DEMOS[0];
  const displayImage = currentDemo.applyEffect(imageId);

  return (
    <div className="app">
      <main className="main-content">
        {/* ── Hero ── */}
        <header className="hero">
          <h1>
            <span className="gradient-text">Cloudinary AI</span> Transformations
          </h1>
          <p className="subtitle">
            See Cloudinary's generative-AI image effects in action — background removal,
            background replace, enhance &amp; object replace — all powered by URL-level
            transformations.
          </p>
        </header>

        {/* ── Upload ── */}
        {hasUploadPreset && (
          <div className="upload-section">
            <h2>📤 Upload Your Own Image</h2>
            <UploadWidget
              onUploadSuccess={handleUploadSuccess}
              onUploadError={handleUploadError}
              buttonText="Upload Image"
            />
          </div>
        )}

        {/* ── AI Demo Selector ── */}
        <section className="demo-section">
          <h2>🤖 Choose an AI Effect</h2>
          <div className="demo-tabs">
            {AI_DEMOS.map((demo) => (
              <button
                key={demo.id}
                className={`demo-tab ${activeDemo === demo.id ? 'active' : ''}`}
                onClick={() => setActiveDemo(demo.id)}
              >
                <span className="tab-emoji">{demo.emoji}</span>
                <span className="tab-label">{demo.title}</span>
              </button>
            ))}
          </div>

          <div className="demo-card">
            <div className="demo-image-wrapper">
              <AdvancedImage
                cldImg={displayImage}
                plugins={[placeholder({ mode: 'blur' }), lazyload()]}
                alt={currentDemo.title}
                className="demo-image"
              />
            </div>
            <div className="demo-info">
              <h3>
                {currentDemo.emoji} {currentDemo.title}
              </h3>
              <p>{currentDemo.description}</p>
              {activeDemo !== 'original' && (
                <p className="demo-hint">
                  💡 <strong>How it works:</strong> This is just a URL parameter added via{' '}
                  <code>@cloudinary/url-gen</code> — no server-side code needed.
                </p>
              )}
            </div>
          </div>
        </section>

        {/* ── Image ID info ── */}
        {uploadedImageId && (
          <p className="image-info">
            Using uploaded image: <code>{uploadedImageId}</code>
          </p>
        )}
      </main>
    </div>
  );
}

export default App;

