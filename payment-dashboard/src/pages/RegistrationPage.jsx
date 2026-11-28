import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { register } from '../api/client';

export default function RegistrationPage() {
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    if (submitting) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await register({ username });
      navigate('/dashboard');
    } catch (err) {
      setError(err?.message || 'Registration failed. Please try again.');
      setSubmitting(false);
    }
  }

  return (
    <div className="registration-page">
      <h1>Register</h1>
      <form onSubmit={handleSubmit}>
        <label htmlFor="username">Username</label>
        <input
          id="username"
          name="username"
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          disabled={submitting}
          required
        />
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" disabled={submitting} aria-busy={submitting ? 'true' : 'false'}>
          {submitting ? 'Registering…' : 'Register'}
        </button>
      </form>
    </div>
  );
}
