use std::ffi::CStr;
use std::path::Path;

use nexnet_term::link::Link;

#[test]
fn serial_open_puts_the_device_in_raw_mode() {
    let mut master = 0;
    let mut slave = 0;
    let mut name = [0 as libc::c_char; 128];
    let rc = unsafe {
        libc::openpty(
            &mut master,
            &mut slave,
            name.as_mut_ptr(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    assert_eq!(rc, 0);
    let path = unsafe { CStr::from_ptr(name.as_ptr()) }
        .to_str()
        .unwrap()
        .to_owned();

    let mut before: libc::termios = unsafe { std::mem::zeroed() };
    unsafe { libc::tcgetattr(slave, &mut before) };
    assert_ne!(before.c_lflag & libc::ECHO, 0);

    let link = Link::open_serial(Path::new(&path)).unwrap();

    let mut after: libc::termios = unsafe { std::mem::zeroed() };
    unsafe { libc::tcgetattr(slave, &mut after) };
    assert_eq!(after.c_lflag & libc::ECHO, 0);
    assert_eq!(after.c_lflag & libc::ICANON, 0);
    assert_eq!(after.c_oflag & libc::OPOST, 0);

    drop(link);
    unsafe {
        libc::close(master);
        libc::close(slave);
    }
}
