// ABOUTME: Owns platform-specific process-tree membership and termination.
// ABOUTME: Provides exact-child identity guards with bounded graceful escalation.
#![allow(dead_code)] // DEPRECATED: legacy embedded-server stack, physical deletion at D10 Stage 2 (all live call sites removed)
use std::process::{Child, ExitStatus};
use std::time::Duration;

#[derive(Debug)]
pub(crate) struct ProcessTree {
    #[cfg(unix)]
    pgid: libc::pid_t,
    #[cfg(windows)]
    job: windows_job::JobHandle,
}

impl ProcessTree {
    pub(crate) fn attach(child: &mut Child) -> Result<Self, String> {
        #[cfg(unix)]
        {
            let pid = child.id() as libc::pid_t;
            let group = unsafe { libc::getpgid(pid) };
            if group != pid {
                return Err(format!(
                    "Pi child process group identity mismatch: {group} != {pid}"
                ));
            }
            Ok(Self { pgid: pid })
        }
        #[cfg(windows)]
        {
            windows_job::create_and_assign(child.id())
                .map(|job| Self { job })
                .ok_or_else(|| "Cannot assign Pi process to Windows Job Object".into())
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = child;
            Ok(Self {})
        }
    }

    pub(crate) fn terminate(&mut self, child: &mut Child) -> Result<(), String> {
        #[cfg(unix)]
        {
            let pid = child.id() as libc::pid_t;
            if child.try_wait().map_err(|e| e.to_string())?.is_some() {
                return Ok(());
            }
            if unsafe { libc::getpgid(pid) } != self.pgid {
                return Err("Pi child identity changed before termination".into());
            }
            if unsafe { libc::kill(-self.pgid, libc::SIGTERM) } != 0
                && unsafe { libc::getpgid(pid) } == self.pgid
            {
                return Err(std::io::Error::last_os_error().to_string());
            }
            for _ in 0..20 {
                if child.try_wait().map_err(|e| e.to_string())?.is_some() {
                    return Ok(());
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            if unsafe { libc::getpgid(pid) } == self.pgid
                && unsafe { libc::kill(-self.pgid, libc::SIGKILL) } != 0
            {
                return Err(std::io::Error::last_os_error().to_string());
            }
        }
        #[cfg(windows)]
        {
            if let Err(job_error) = windows_job::terminate(&self.job) {
                child.kill().map_err(|child_error| {
                    format!("{job_error}; direct-child fallback failed: {child_error}")
                })?;
            }
        }
        #[cfg(not(any(unix, windows)))]
        child.kill().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub(crate) fn wait(child: &mut Child) -> Result<ExitStatus, String> {
        child.wait().map_err(|e| e.to_string())
    }
}

#[cfg(unix)]
pub(crate) fn configure_child(command: &mut std::process::Command) {
    use std::os::unix::process::CommandExt;
    unsafe {
        command.pre_exec(|| {
            if libc::setpgid(0, 0) == 0 {
                Ok(())
            } else {
                Err(std::io::Error::last_os_error())
            }
        });
    }
}
#[cfg(not(unix))]
pub(crate) fn configure_child(_command: &mut std::process::Command) {}

#[cfg(windows)]
mod windows_job {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::*;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };
    #[derive(Debug)]
    pub struct JobHandle(HANDLE);
    unsafe impl Send for JobHandle {}
    unsafe impl Sync for JobHandle {}
    impl Drop for JobHandle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    pub fn create_and_assign(pid: u32) -> Option<JobHandle> {
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return None;
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&mut limits as *mut _).cast(),
                std::mem::size_of_val(&limits) as u32,
            ) == 0
            {
                CloseHandle(job);
                return None;
            }
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if process.is_null() || AssignProcessToJobObject(job, process) == 0 {
                if !process.is_null() {
                    CloseHandle(process);
                }
                CloseHandle(job);
                return None;
            }
            CloseHandle(process);
            Some(JobHandle(job))
        }
    }
    pub fn terminate(job: &JobHandle) -> Result<(), String> {
        unsafe {
            if TerminateJobObject(job.0, 1) == 0 {
                Err(std::io::Error::last_os_error().to_string())
            } else {
                Ok(())
            }
        }
    }
}
