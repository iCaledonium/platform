import { Routes, Route, Navigate } from "react-router-dom";
import LoginPage from "./pages/LoginPage.jsx";
import EnrollPage from "./pages/EnrollPage.jsx";
import HomePage from "./pages/HomePage.jsx";

export default function App() {
  return (
    <Routes>
      <Route path="/login"  element={<LoginPage />} />
      <Route path="/enroll" element={<EnrollPage />} />
      <Route path="/home"   element={<HomePage />} />
      <Route path="*"       element={<Navigate to="/login" replace />} />
    </Routes>
  );
}
