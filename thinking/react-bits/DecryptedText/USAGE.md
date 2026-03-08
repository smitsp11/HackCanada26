# DecryptedText — Usage

```tsx
import DecryptedText from './DecryptedText';

{/* Example 1: Defaults (hover to decrypt) */}
<DecryptedText text="Hover me!" />

{/* Example 2: Customized speed and characters */}
<DecryptedText
  text="Customize me"
  speed={60}
  maxIterations={10}
  characters="ABCD1234!?"
  className="revealed"
  parentClassName="all-letters"
  encryptedClassName="encrypted"
/>

{/* Example 3: Animate on view (runs once) */}
<div style={{ marginTop: '4rem' }}>
  <DecryptedText
    text="This text animates when in view"
    animateOn="view"
    revealDirection="start"
    sequential
    useOriginalCharsOnly={false}
  />
</div>
```
