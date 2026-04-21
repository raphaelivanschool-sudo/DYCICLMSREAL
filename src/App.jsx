import {
  BrowserRouter as Router,
  Routes,
  Route,
  Navigate,
} from "react-router-dom";
import Login from "./pages/Login";
import ProtectedRoute from "./components/ProtectedRoute";
import AdminLayout from "./components/layout/AdminLayout";
import Dashboard from "./pages/admin/Dashboard";
import UserManagement from "./pages/admin/UserManagement";
import ScheduleManagement from "./pages/admin/ScheduleManagement";
import Laboratories from "./pages/admin/Laboratories";
import Computers from "./pages/admin/Computers";
import NetworkControl from "./pages/admin/NetworkControl";
import SecuritySettings from "./pages/admin/SecuritySettings";
import SystemLogs from "./pages/admin/SystemLogs";
import Tickets from "./pages/admin/Tickets";
import HardwareInventory from "./pages/admin/HardwareInventory";
import DeveloperModePage from "./pages/admin/DeveloperModePage";

// Instructor imports
import InstructorLayout from "./components/layout/InstructorLayout";
import ClassroomDashboard from "./pages/instructor/ClassroomDashboard";
import StudentScreenMonitoring from "./pages/instructor/StudentScreenMonitoring";
import ControlActions from "./pages/instructor/ControlActions";
import Messaging from "./pages/instructor/Messaging";
import TicketApproval from "./pages/instructor/TicketApproval";

// Student imports
import StudentLayout from "./components/layout/StudentLayout";
import SessionDashboard from "./pages/student/SessionDashboard";
import SupportTicket from "./pages/student/SupportTicket";
import StudentMessaging from "./pages/student/Messaging";

// Grading imports
import GradingPanel from "./pages/grading/GradingPanel";
import MyGrades from "./pages/grading/MyGrades";

// Agent Control imports
import { AgentControlPage } from "./features/agent-control";

function App() {
  return (
    <Router>
      <Routes>
        {/* Login Page - Public */}
        <Route path="/" element={<Login />} />

        {/* Admin Routes */}
        <Route
          path="/admin"
          element={
            <ProtectedRoute allowedRoles={["admin"]}>
              <AdminLayout />
            </ProtectedRoute>
          }
        >
          <Route index element={<Navigate to="dashboard" replace />} />
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="users" element={<UserManagement />} />
          <Route path="schedules" element={<ScheduleManagement />} />
          <Route path="laboratories" element={<Laboratories />} />
          <Route path="computers" element={<Computers />} />
          <Route path="network" element={<NetworkControl />} />
          <Route path="security" element={<SecuritySettings />} />
          <Route path="logs" element={<SystemLogs />} />
          <Route path="tickets" element={<Tickets />} />
          <Route path="hardware-inventory" element={<HardwareInventory />} />
          <Route path="developer" element={<DeveloperModePage />} />
          <Route path="grading" element={<GradingPanel />} />
          <Route path="agent-control" element={<AgentControlPage />} />
        </Route>

        {/* Instructor Routes */}
        <Route
          path="/instructor"
          element={
            <ProtectedRoute allowedRoles={["instructor"]}>
              <InstructorLayout />
            </ProtectedRoute>
          }
        >
          <Route index element={<Navigate to="dashboard" replace />} />
          <Route path="dashboard" element={<ClassroomDashboard />} />
          <Route path="monitoring" element={<StudentScreenMonitoring />} />
          <Route path="controls" element={<ControlActions />} />
          <Route path="messaging" element={<Messaging />} />
          <Route path="ticket-approval" element={<TicketApproval />} />
          <Route path="grading" element={<GradingPanel />} />
        </Route>

        {/* Student Routes */}
        <Route
          path="/student"
          element={
            <ProtectedRoute allowedRoles={["student"]}>
              <StudentLayout />
            </ProtectedRoute>
          }
        >
          <Route index element={<Navigate to="dashboard" replace />} />
          <Route path="dashboard" element={<SessionDashboard />} />
          <Route path="tickets" element={<SupportTicket />} />
          <Route path="messaging" element={<StudentMessaging />} />
          <Route path="my-grades" element={<MyGrades />} />
        </Route>

        {/* Catch all - Redirect to login */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Router>
  );
}

export default App;
